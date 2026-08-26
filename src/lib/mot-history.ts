import type { createAdminClient } from "@/lib/supabase/admin";
import type { MotTest } from "@/lib/dvla";

// MOT test persistence (#596). DVSA gives us the full odometer + defect
// series on every history lookup and in every nightly delta record, but until
// now both paths threw it away. mot_tests is the durable store the mileage
// estimator (PR 3) reads — one row per (vehicle, test date), odometer
// normalised to MILES at ingest (KM readings appear on imports and NI
// vehicles; converting at read time would poison every consumer that forgot).

const KM_TO_MILES = 0.621371;

export type MotTestRow = {
  vehicle_id: string;
  organization_id: string;
  test_date: string; // YYYY-MM-DD
  result: string | null;
  odometer_miles: number | null;
  defects: { text: string; type: string }[];
  source: "lookup" | "delta";
};

export function odometerToMiles(value: unknown, unit: unknown): number | null {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const u = String(unit ?? "MI").toUpperCase();
  return u === "KM" ? Math.round(n * KM_TO_MILES) : Math.round(n);
}

/**
 * One row per (vehicle, test_date) — a same-day fail + pass retest would
 * violate the unique key inside a single upsert statement. Keep the PASSED
 * result when dates collide (it carries the expiry-relevant outcome and the
 * later odometer of the day); otherwise last occurrence wins.
 */
export function dedupeMotTestRows(rows: MotTestRow[]): MotTestRow[] {
  const byKey = new Map<string, MotTestRow>();
  for (const row of rows) {
    const key = `${row.vehicle_id}:${row.test_date}`;
    const existing = byKey.get(key);
    if (existing && existing.result === "PASSED" && row.result !== "PASSED") continue;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

export function motTestsToRows(
  vehicleId: string,
  organizationId: string,
  tests: MotTest[],
  source: "lookup" | "delta",
): MotTestRow[] {
  const rows: MotTestRow[] = [];
  for (const t of tests) {
    const testDate = t.completedDate?.slice(0, 10) ?? null;
    if (!testDate || !/^\d{4}-\d{2}-\d{2}$/.test(testDate)) continue;
    rows.push({
      vehicle_id: vehicleId,
      organization_id: organizationId,
      test_date: testDate,
      result: t.testResult || null,
      odometer_miles: odometerToMiles(t.odometerValue, t.odometerUnit),
      defects: t.defects.map((d) => ({ text: d.text, type: d.type })),
      source,
    });
  }
  return dedupeMotTestRows(rows);
}

const UPSERT_CHUNK = 500;

/**
 * Idempotent write — safe to call on every lookup/delta pass. Never throws:
 * MOT persistence is an enrichment, not a request-critical path.
 */
export async function persistMotTests(
  admin: ReturnType<typeof createAdminClient>,
  rows: MotTestRow[],
): Promise<{ upserted: number; error: string | null }> {
  const deduped = dedupeMotTestRows(rows);
  let upserted = 0;
  for (let i = 0; i < deduped.length; i += UPSERT_CHUNK) {
    const chunk = deduped
      .slice(i, i + UPSERT_CHUNK)
      .map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    const { error } = await admin
      .from("mot_tests")
      .upsert(chunk, { onConflict: "vehicle_id,test_date" });
    if (error) return { upserted, error: error.message };
    upserted += chunk.length;
  }
  return { upserted, error: null };
}
