import { z } from "zod";
import { IsoDateSchema } from "./common";
import { SegmentSchema } from "./segment";

export const RetentionSchema = z.object({
  deliveriesMonths: z.number().int().positive().nullable(),
  rejectedProspectsMonths: z.number().int().positive(),
  enrichmentTextMonths: z.number().int().positive(),
  rawProviderPayloadDays: z.number().int().positive(),
  eventsMonths: z.number().int().positive(),
  runMetadataMonths: z.number().int().positive(),
});

export const DiscoveryConfigSchema = z.object({
  maxResultsPerCategory: z.number().int().min(1).max(500),
  minIntervalMs: z.number().int().min(0).max(5_000),
  dailyCreditBudget: z.number().int().positive(),
  defaultCountryCode: z
    .string()
    .regex(/^[a-z]{2}$/, "Use a lowercase ISO country code")
    .nullable(),
});

export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

export const DISCOVERY_DEFAULTS: DiscoveryConfig = {
  maxResultsPerCategory: 500,
  minIntervalMs: 300,
  dailyCreditBudget: 3_000,
  defaultCountryCode: "in",
};

export const NegativeFlagSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    mode: z.enum(["exclude", "deduct"]),
    points: z.number().int().min(0),
  })
  .superRefine((flag, ctx) => {
    if (flag.mode === "exclude" && flag.points !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exclude flags must carry 0 points" });
    }
    if (flag.mode === "deduct" && flag.points === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deduct flags need points above 0" });
    }
  });

export const RubricSchema = z
  .object({
    version: z.number().int().positive(),
    fit: z.object({
      serviceFit: z.number().min(0).max(100),
      size: z.number().min(0).max(100),
      tenure: z.number().min(0).max(100),
      geography: z.number().min(0).max(100),
    }),
    contactability: z.object({
      reachableChannel: z.number().min(0).max(100),
      workingSite: z.number().min(0).max(100),
      contactPath: z.number().min(0).max(100),
      freshness: z.number().min(0).max(100),
    }),
    serviceFitTagPoints: z.record(z.string(), z.number().int().min(0).max(50)),
    negativeFlags: z.array(NegativeFlagSchema),
    unknownCredit: z.object({
      size: z.number().min(0).max(0.5),
      tenure: z.number().min(0).max(0.5),
    }),
  })
  .superRefine((rubric, ctx) => {
    const fitSum =
      rubric.fit.serviceFit + rubric.fit.size + rubric.fit.tenure + rubric.fit.geography;
    if (fitSum !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `fit weights must sum to 100, got ${fitSum}`,
      });
    }
    const contactabilitySum =
      rubric.contactability.reachableChannel +
      rubric.contactability.workingSite +
      rubric.contactability.contactPath +
      rubric.contactability.freshness;
    if (contactabilitySum !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `contactability weights must sum to 100, got ${contactabilitySum}`,
      });
    }
    for (const [tag, points] of Object.entries(rubric.serviceFitTagPoints)) {
      if (points > rubric.fit.serviceFit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `tag ${tag} cannot exceed serviceFit weight`,
        });
      }
    }
  });

export const SettingsConfigSchema = z
  .object({
    segments: z.array(SegmentSchema).min(1),
    rubrics: z.record(z.string(), RubricSchema),
    retention: RetentionSchema,
    discovery: DiscoveryConfigSchema.default(DISCOVERY_DEFAULTS),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const segment of config.segments) {
      if (ids.has(segment.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate segment id ${segment.id}`,
        });
      }
      ids.add(segment.id);
      if (!config.rubrics[segment.id]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing rubric for segment ${segment.id}`,
        });
      }
    }
    for (const id of Object.keys(config.rubrics)) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rubric ${id} has no matching segment`,
        });
      }
    }
    if (config.segments.every((segment) => !segment.enabled)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one segment must be enabled",
      });
    }
  });

export const SettingsMetaSchema = z.object({
  configVersion: z.number().int().positive(),
  approved: z.boolean(),
  provisional: z.boolean(),
  provisionalReason: z.string().nullable(),
  updatedAt: IsoDateSchema,
  updatedBy: z.string().min(1),
});

export const SettingsSchema = SettingsConfigSchema.and(SettingsMetaSchema);

export const SettingsUpdateSchema = SettingsConfigSchema;

export const SettingsApproveSchema = z.object({
  note: z.string().max(500).optional(),
});

export type Retention = z.infer<typeof RetentionSchema>;
export type Rubric = z.infer<typeof RubricSchema>;
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
export type SettingsMeta = z.infer<typeof SettingsMetaSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

export const PROVISIONAL_REASON =
  "Provisional defaults pending Kripa's approval (weights, fit floor 40, retention, solo off).";

const BASE_RETENTION: Retention = {
  deliveriesMonths: null,
  rejectedProspectsMonths: 12,
  enrichmentTextMonths: 12,
  rawProviderPayloadDays: 90,
  eventsMonths: 12,
  runMetadataMonths: 24,
};

const SHARED_NEGATIVE_FLAGS = [
  { id: "directory_aggregator", label: "Directory or aggregator", mode: "exclude" as const, points: 0 },
  { id: "defunct", label: "Defunct or closed", mode: "exclude" as const, points: 0 },
  { id: "franchise", label: "Franchise", mode: "deduct" as const, points: 30 },
  { id: "enterprise_brand", label: "Enterprise brand", mode: "deduct" as const, points: 15 },
];

const BASE_RUBRIC = {
  version: 1,
  fit: { serviceFit: 50, size: 25, tenure: 15, geography: 10 },
  contactability: { reachableChannel: 40, workingSite: 30, contactPath: 20, freshness: 10 },
  negativeFlags: SHARED_NEGATIVE_FLAGS,
  unknownCredit: { size: 0.5, tenure: 0.5 },
};

export const DEFAULT_SETTINGS_CONFIG: SettingsConfig = {
  segments: [
    {
      id: "msme",
      label: "MSME",
      buyer: "Indian MSMEs, funded startups, proprietors",
      enabled: true,
      categories: ["office.company", "office.it", "commercial"],
      tags: [
        "gst_registered",
        "payroll_mention",
        "multi_state",
        "export_mention",
        "funding_or_startup",
        "audit_mention",
      ],
      soloPolicy: "off",
      fitFloor: 40,
    },
    {
      id: "ca_firm",
      label: "CA firm",
      buyer: "Accounting practices buying white-label capacity",
      enabled: false,
      categories: ["office.accountant", "office.tax_advisor", "office.financial_advisor"],
      tags: [
        "bookkeeping",
        "gst_services",
        "roc_services",
        "payroll_services",
        "virtual_cfo",
        "team_page",
      ],
      soloPolicy: "off",
      fitFloor: 40,
    },
    {
      id: "manufacturer_distributor",
      label: "Manufacturer or distributor",
      buyer: "Manufacturers and distributors, pending Kripa confirmation",
      enabled: false,
      categories: ["production.factory", "commercial.trade", "office.company"],
      tags: ["manufacturing", "distribution", "export_mention", "gst_registered"],
      soloPolicy: "off",
      fitFloor: 40,
    },
  ],
  rubrics: {
    msme: {
      ...BASE_RUBRIC,
      serviceFitTagPoints: {
        gst_registered: 10,
        payroll_mention: 10,
        multi_state: 8,
        export_mention: 8,
        funding_or_startup: 7,
        audit_mention: 7,
      },
    },
    ca_firm: {
      ...BASE_RUBRIC,
      serviceFitTagPoints: {
        bookkeeping: 10,
        gst_services: 10,
        roc_services: 8,
        payroll_services: 8,
        virtual_cfo: 7,
        team_page: 7,
      },
    },
    manufacturer_distributor: {
      ...BASE_RUBRIC,
      serviceFitTagPoints: {
        manufacturing: 15,
        distribution: 15,
        export_mention: 10,
        gst_registered: 10,
      },
    },
  },
  retention: BASE_RETENTION,
  discovery: DISCOVERY_DEFAULTS,
};
