import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_CONFIG,
  PROVISIONAL_REASON,
  SettingsConfigSchema,
  SettingsSchema,
} from "@kripa/shared";

describe("default settings", () => {
  it("validates against the settings schema", () => {
    expect(() => SettingsConfigSchema.parse(DEFAULT_SETTINGS_CONFIG)).not.toThrow();
  });

  it("keeps every rubric weight at 100", () => {
    for (const rubric of Object.values(DEFAULT_SETTINGS_CONFIG.rubrics)) {
      const fit =
        rubric.fit.serviceFit + rubric.fit.size + rubric.fit.tenure + rubric.fit.geography;
      const contactability =
        rubric.contactability.reachableChannel +
        rubric.contactability.workingSite +
        rubric.contactability.contactPath +
        rubric.contactability.freshness;
      expect(fit).toBe(100);
      expect(contactability).toBe(100);
    }
  });

  it("ships msme enabled and the parked segments disabled", () => {
    const byId = new Map(DEFAULT_SETTINGS_CONFIG.segments.map((segment) => [segment.id, segment]));
    expect(byId.get("msme")?.enabled).toBe(true);
    expect(byId.get("msme")?.fitFloor).toBe(40);
    expect(byId.get("msme")?.categories).toEqual(["office.company", "office.it", "commercial"]);
    expect(byId.get("ca_firm")?.enabled).toBe(false);
    expect(byId.get("manufacturer_distributor")?.enabled).toBe(false);
  });

  it("keeps retention aligned with the plan", () => {
    expect(DEFAULT_SETTINGS_CONFIG.retention).toEqual({
      deliveriesMonths: null,
      rejectedProspectsMonths: 12,
      enrichmentTextMonths: 12,
      rawProviderPayloadDays: 90,
      eventsMonths: 12,
      runMetadataMonths: 24,
    });
  });

  it("marks the configuration provisional", () => {
    const settings = SettingsSchema.parse({
      ...DEFAULT_SETTINGS_CONFIG,
      configVersion: 1,
      approved: false,
      provisional: true,
      provisionalReason: PROVISIONAL_REASON,
      updatedAt: new Date().toISOString(),
      updatedBy: "system",
    });
    expect(settings.provisional).toBe(true);
    expect(settings.provisionalReason).toContain("pending Kripa");
  });
});
