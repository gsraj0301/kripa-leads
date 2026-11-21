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

export const EnterpriseFilterSchema = z.object({
  enabled: z.boolean().default(true),
  brands: z.array(z.string().min(1)).default([]),
  operators: z.array(z.string().min(1)).default([]),
});

export type EnterpriseFilter = z.infer<typeof EnterpriseFilterSchema>;

export const ENTERPRISE_FILTER_DEFAULTS: EnterpriseFilter = {
  enabled: true,
  brands: [
    "decathlon",
    "firstcry",
    "tata",
    "taneira",
    "royal enfield",
    "oneplus",
    "ashok leyland",
    "trimble",
    "beta cae",
  ],
  operators: ["brainbees solutions limited"],
};

export const DiscoveryConfigSchema = z.object({
  maxResultsPerCategory: z.number().int().min(1).max(500),
  minIntervalMs: z.number().int().min(0).max(5_000),
  dailyCreditBudget: z.number().int().positive(),
  defaultCountryCode: z
    .string()
    .regex(/^[a-z]{2}$/, "Use a lowercase ISO country code")
    .nullable(),
  enterpriseFilter: EnterpriseFilterSchema.default(ENTERPRISE_FILTER_DEFAULTS),
});

export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

export const DISCOVERY_DEFAULTS: DiscoveryConfig = {
  maxResultsPerCategory: 500,
  minIntervalMs: 300,
  dailyCreditBudget: 3_000,
  defaultCountryCode: "in",
  enterpriseFilter: ENTERPRISE_FILTER_DEFAULTS,
};

export const EnrichmentConfigSchema = z.object({
  maxPagesPerProspect: z.number().int().min(1).max(5),
  pageTimeoutMs: z.number().int().min(1_000).max(30_000),
  prospectBudgetMs: z.number().int().min(5_000).max(120_000),
  maxConcurrency: z.number().int().min(1).max(10),
  maxRedirects: z.number().int().min(0).max(10),
  maxHtmlBytes: z.number().int().min(10_000).max(2_000_000),
  totalTextChars: z.number().int().min(400).max(200_000),
  minUsableTextChars: z.number().int().min(100).max(5_000),
  respectRobots: z.boolean(),
  robotsCacheTtlSeconds: z.number().int().min(0).max(604_800),
  userAgent: z.string().min(5).max(200),
});

export type EnrichmentConfig = z.infer<typeof EnrichmentConfigSchema>;

export const ENRICHMENT_DEFAULTS: EnrichmentConfig = {
  maxPagesPerProspect: 3,
  pageTimeoutMs: 10_000,
  prospectBudgetMs: 60_000,
  maxConcurrency: 4,
  maxRedirects: 5,
  maxHtmlBytes: 750_000,
  totalTextChars: 30_000,
  minUsableTextChars: 400,
  respectRobots: true,
  robotsCacheTtlSeconds: 86_400,
  userAgent: "KripaLeadsBot/0.1 (+https://leads.kripa.tech)",
};

export const PageBudgetsSchema = z.object({
  home: z.number().int().min(0).max(5_000),
  about: z.number().int().min(0).max(5_000),
  team: z.number().int().min(0).max(5_000),
  contact: z.number().int().min(0).max(5_000),
  other: z.number().int().min(0).max(5_000),
});

export type PageBudgets = z.infer<typeof PageBudgetsSchema>;

export const PAGE_BUDGETS_DEFAULTS: PageBudgets = {
  home: 1_000,
  about: 1_200,
  team: 800,
  contact: 800,
  other: 400,
};

export const ExtractionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().min(1).max(120).default("openai/gpt-oss-120b"),
  maxInputChars: z.number().int().min(500).max(6_000).default(3_000),
  pageBudgets: PageBudgetsSchema.default(PAGE_BUDGETS_DEFAULTS),
  maxOutputTokens: z.number().int().min(100).max(2_000).default(800),
  temperature: z.number().min(0).max(1).default(0),
  reasoningEffort: z.enum(["low", "medium", "high"]).default("low"),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  minIntervalMs: z.number().int().min(0).max(60_000).default(10_000),
  dailyTokenBudget: z.number().int().positive().default(200_000),
  runTokenBudget: z.number().int().positive().default(140_000),
  estimatedTokensPerProspect: z.number().int().min(100).default(1_300),
}).superRefine((config, ctx) => {
  if (config.runTokenBudget < config.estimatedTokensPerProspect) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "runTokenBudget must cover at least one estimated prospect call",
    });
  }
  if (config.dailyTokenBudget < config.estimatedTokensPerProspect) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dailyTokenBudget must cover at least one estimated prospect call",
    });
  }
});

export type ExtractionConfig = z.infer<typeof ExtractionConfigSchema>;

export const EXTRACTION_DEFAULTS: ExtractionConfig = {
  enabled: true,
  model: "openai/gpt-oss-120b",
  maxInputChars: 3_000,
  pageBudgets: PAGE_BUDGETS_DEFAULTS,
  maxOutputTokens: 800,
  temperature: 0,
  reasoningEffort: "low",
  timeoutMs: 30_000,
  maxRetries: 2,
  minIntervalMs: 10_000,
  dailyTokenBudget: 200_000,
  runTokenBudget: 140_000,
  estimatedTokensPerProspect: 1_300,
};

export const ScoreThresholdsSchema = z.object({
  low: z.number().int().min(0).max(100),
  medium: z.number().int().min(0).max(100),
  high: z.number().int().min(0).max(100),
});

export const ScoringBandsSchema = z
  .object({
    fit: ScoreThresholdsSchema,
    contactability: ScoreThresholdsSchema,
  })
  .superRefine((bands, ctx) => {
    for (const key of ["fit", "contactability"] as const) {
      const band = bands[key];
      if (!(band.low < band.medium && band.medium < band.high)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} band thresholds must increase: low < medium < high`,
        });
      }
    }
  });

export const ScoringConfigSchema = z.object({
  bands: ScoringBandsSchema.default({
    fit: { low: 40, medium: 60, high: 80 },
    contactability: { low: 20, medium: 40, high: 70 },
  }),
  manualResearchBelowContactability: z.number().int().min(0).max(100).default(40),
  roleEmailPrefixes: z
    .array(z.string().min(1))
    .default([
      "info",
      "sales",
      "contact",
      "support",
      "admin",
      "hello",
      "enquiry",
      "enquiries",
      "hr",
      "careers",
      "office",
      "accounts",
      "team",
    ]),
});

export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;
export type ScoringBands = z.infer<typeof ScoringBandsSchema>;

export const ExportConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

export type ExportConfig = z.infer<typeof ExportConfigSchema>;

export const EXPORT_DEFAULTS: ExportConfig = {
  enabled: false,
};

export const PlanYieldsSchema = z.object({
  rawPerValid: z.number().min(0),
  enrichedPerValid: z.number().min(0).max(1),
  scoredPerEnriched: z.number().min(0).max(1),
  aboveFloorPerScored: z.number().min(0).max(1),
  observedRuns: z.number().int().min(0).default(1),
  observedCities: z.number().int().min(0).default(1),
});

export type PlanYields = z.infer<typeof PlanYieldsSchema>;

export const PLAN_YIELDS_DEFAULTS: PlanYields = {
  rawPerValid: 1.35,
  enrichedPerValid: 0.56,
  scoredPerEnriched: 0.84,
  aboveFloorPerScored: 0.30,
  observedRuns: 1,
  observedCities: 1,
};

export const SCORING_DEFAULTS: ScoringConfig = {
  bands: {
    fit: { low: 40, medium: 60, high: 80 },
    contactability: { low: 20, medium: 40, high: 70 },
  },
  manualResearchBelowContactability: 40,
  roleEmailPrefixes: [
    "info",
    "sales",
    "contact",
    "support",
    "admin",
    "hello",
    "enquiry",
    "enquiries",
    "hr",
    "careers",
    "office",
    "accounts",
    "team",
  ],
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

export const RUBRIC_POINTS_DEFAULTS = {
  size: {
    headcount: { one: 0, micro: 8, small: 15, mid: 10, large: 4 },
    offices: { one: 0, few: 6, many: 10 },
  },
  tenure: { foundedRecent: 0, foundedMid: 5, foundedOld: 8, teamPage: 7 },
  reachable: { phone: 25, emailRole: 15, emailPersonal: 10 },
  workingSite: { https: 30, httpOnly: 15, unrelatedRedirect: 5 },
  contactPath: { contact: 12, social: 8 },
  freshness: { current: 10, previous: 6, older: 3 },
  geography: { in: 10, adjacent: 5, outside: 0 },
};

export const RubricPointsSchema = z.object({
  size: z.object({
    headcount: z.object({
      one: z.number().min(0),
      micro: z.number().min(0),
      small: z.number().min(0),
      mid: z.number().min(0),
      large: z.number().min(0),
    }),
    offices: z.object({
      one: z.number().min(0),
      few: z.number().min(0),
      many: z.number().min(0),
    }),
  }),
  tenure: z.object({
    foundedRecent: z.number().min(0),
    foundedMid: z.number().min(0),
    foundedOld: z.number().min(0),
    teamPage: z.number().min(0),
  }),
  reachable: z.object({
    phone: z.number().min(0),
    emailRole: z.number().min(0),
    emailPersonal: z.number().min(0),
  }),
  workingSite: z.object({
    https: z.number().min(0),
    httpOnly: z.number().min(0),
    unrelatedRedirect: z.number().min(0),
  }),
  contactPath: z.object({
    contact: z.number().min(0),
    social: z.number().min(0),
  }),
  freshness: z.object({
    current: z.number().min(0),
    previous: z.number().min(0),
    older: z.number().min(0),
  }),
  geography: z.object({
    in: z.number().min(0),
    adjacent: z.number().min(0),
    outside: z.number().min(0),
  }),
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
    points: RubricPointsSchema.default(RUBRIC_POINTS_DEFAULTS),
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

    const maxOf = (values: number[]) => Math.max(...values);
    const points = rubric.points;
    const checks: Array<[string, number, number]> = [
      [
        "size headcount + offices",
        maxOf(Object.values(points.size.headcount)) + maxOf(Object.values(points.size.offices)),
        rubric.fit.size,
      ],
      [
        "tenure founding + team page",
        maxOf([
          points.tenure.foundedRecent,
          points.tenure.foundedMid,
          points.tenure.foundedOld,
        ]) + points.tenure.teamPage,
        rubric.fit.tenure,
      ],
      [
        "reachable phone + role email",
        points.reachable.phone + points.reachable.emailRole,
        rubric.contactability.reachableChannel,
      ],
      [
        "working site",
        maxOf(Object.values(points.workingSite)),
        rubric.contactability.workingSite,
      ],
      [
        "contact path contact + social",
        points.contactPath.contact + points.contactPath.social,
        rubric.contactability.contactPath,
      ],
      [
        "freshness",
        maxOf(Object.values(points.freshness)),
        rubric.contactability.freshness,
      ],
      [
        "geography",
        maxOf(Object.values(points.geography)),
        rubric.fit.geography,
      ],
    ];
    for (const [label, actual, expected] of checks) {
      if (actual !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} points must equal the component weight ${expected}, got ${actual}`,
        });
      }
    }
    if (points.reachable.emailPersonal > points.reachable.emailRole) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "personal email points cannot exceed role email points",
      });
    }
  });

export const SettingsConfigSchema = z
  .object({
    segments: z.array(SegmentSchema).min(1),
    rubrics: z.record(z.string(), RubricSchema),
    retention: RetentionSchema,
    discovery: DiscoveryConfigSchema.default(DISCOVERY_DEFAULTS),
    enrichment: EnrichmentConfigSchema.default(ENRICHMENT_DEFAULTS),
    extraction: ExtractionConfigSchema.default(EXTRACTION_DEFAULTS),
    scoring: ScoringConfigSchema.default(SCORING_DEFAULTS),
    exports: ExportConfigSchema.default(EXPORT_DEFAULTS),
    planYields: PlanYieldsSchema.default(PLAN_YIELDS_DEFAULTS),
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
      if (segment.tenureTag && !segment.tags.includes(segment.tenureTag)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `segment ${segment.id} tenureTag must be one of its tags`,
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
  points: RUBRIC_POINTS_DEFAULTS,
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
        "multi_outlet",
        "distribution_network",
        "manufacturing",
        "export_import",
        "hiring_team",
      ],
      tagDefinitions: {
        gst_registered: "GST registration, a GSTIN, or GST filing is mentioned.",
        multi_outlet:
          "More than one outlet, branch, store, showroom, depot, or office is mentioned.",
        distribution_network:
          "The company states that it has its own dealers, distributors, resellers, stockists, wholesalers, or a distribution network. Being a dealer, reseller, or franchisee of another brand does not count.",
        manufacturing:
          "The company states that it manufactures, produces, or makes products itself (its own factory, plant, production line, or made-to-order capability). Selling, trading, or reselling another brand's products does not count.",
        export_import:
          "Imports, exports, international clients, or overseas markets are mentioned.",
        hiring_team:
          "A team, careers page, hiring, employee headcount, or staff page is mentioned.",
      },
      soloPolicy: "off",
      soloCap: 50,
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
      tenureTag: "team_page",
      tagDefinitions: {
        bookkeeping: "Bookkeeping, accounting, or bank reconciliation services are offered.",
        gst_services: "GST registration, return filing, or GST advisory services are offered.",
        roc_services: "ROC, company incorporation, or MCA compliance services are offered.",
        payroll_services: "Payroll processing or salary compliance services are offered.",
        virtual_cfo: "Virtual CFO, outsourced CFO, or financial advisory services are offered.",
        team_page: "A team, partners, leadership, or people page or section is present.",
      },
      soloPolicy: "off",
      soloCap: 50,
      fitFloor: 40,
    },
    {
      id: "manufacturer_distributor",
      label: "Manufacturer or distributor",
      buyer: "Manufacturers and distributors, pending Kripa confirmation",
      enabled: false,
      categories: ["production.factory", "commercial.trade", "office.company"],
      tags: ["manufacturing", "distribution", "export_mention", "gst_registered"],
      tagDefinitions: {
        manufacturing:
          "The company states that it manufactures, produces, or makes products itself (its own factory, plant, production line, or made-to-order capability).",
        distribution:
          "The company states that it has its own dealers, distributors, resellers, stockists, wholesalers, or a distribution network.",
        export_mention: "Exports, international clients, or overseas markets are mentioned.",
        gst_registered: "GST registration, a GSTIN, or GST filing is mentioned.",
      },
      soloPolicy: "off",
      soloCap: 50,
      fitFloor: 40,
    },
  ],
  rubrics: {
    msme: {
      ...BASE_RUBRIC,
      serviceFitTagPoints: {
        gst_registered: 8,
        multi_outlet: 10,
        distribution_network: 10,
        manufacturing: 10,
        export_import: 7,
        hiring_team: 5,
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
  enrichment: ENRICHMENT_DEFAULTS,
  extraction: EXTRACTION_DEFAULTS,
  scoring: SCORING_DEFAULTS,
  exports: EXPORT_DEFAULTS,
  planYields: PLAN_YIELDS_DEFAULTS,
};
