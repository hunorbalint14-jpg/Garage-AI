import { describe, it, expect } from "vitest";
import { odometerToMiles, dedupeMotTestRows, motTestsToRows, type MotTestRow } from "./mot-history";
import type { MotTest } from "./dvla";

describe("odometerToMiles", () => {
  it("passes miles through rounded", () => {
    expect(odometerToMiles("45210", "MI")).toBe(45210);
    expect(odometerToMiles(45210, "mi")).toBe(45210);
  });

  it("converts kilometres", () => {
    expect(odometerToMiles("100000", "KM")).toBe(62137);
  });

  it("defaults a missing unit to miles", () => {
    expect(odometerToMiles("12345", null)).toBe(12345);
  });

  it("rejects garbage and negatives", () => {
    expect(odometerToMiles(null, "MI")).toBeNull();
    expect(odometerToMiles("not a number", "MI")).toBeNull();
    expect(odometerToMiles("-5", "MI")).toBeNull();
  });
});

function row(overrides: Partial<MotTestRow>): MotTestRow {
  return {
    vehicle_id: "v1",
    organization_id: "o1",
    test_date: "2026-06-09",
    result: "PASSED",
    odometer_miles: 40000,
    defects: [],
    source: "lookup",
    ...overrides,
  };
}

describe("dedupeMotTestRows", () => {
  it("keeps the PASSED result on a same-day retest", () => {
    const out = dedupeMotTestRows([
      row({ result: "PASSED", odometer_miles: 40010 }),
      row({ result: "FAILED", odometer_miles: 40000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe("PASSED");
    expect(out[0].odometer_miles).toBe(40010);
  });

  it("lets a later PASSED replace an earlier FAILED", () => {
    const out = dedupeMotTestRows([
      row({ result: "FAILED" }),
      row({ result: "PASSED" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe("PASSED");
  });

  it("keeps different dates and vehicles apart", () => {
    const out = dedupeMotTestRows([
      row({}),
      row({ test_date: "2025-06-01" }),
      row({ vehicle_id: "v2" }),
    ]);
    expect(out).toHaveLength(3);
  });
});

describe("motTestsToRows", () => {
  const tests: MotTest[] = [
    {
      completedDate: "2026-06-09T10:00:00.000Z",
      testResult: "PASSED",
      expiryDate: "2027-06-08",
      odometerValue: "45210",
      odometerUnit: "MI",
      defects: [{ text: "Nearside front tyre worn close to the legal limit", type: "ADVISORY" }],
    },
    {
      completedDate: null, // unparseable date → dropped
      testResult: "PASSED",
      expiryDate: null,
      odometerValue: "44000",
      odometerUnit: "MI",
      defects: [],
    },
  ];

  it("maps, normalises, and drops dateless tests", () => {
    const rows = motTestsToRows("v1", "o1", tests, "lookup");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      vehicle_id: "v1",
      organization_id: "o1",
      test_date: "2026-06-09",
      result: "PASSED",
      odometer_miles: 45210,
      source: "lookup",
    });
    expect(rows[0].defects[0].type).toBe("ADVISORY");
  });
});
