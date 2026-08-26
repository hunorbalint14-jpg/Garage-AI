import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeEqual } from "@/lib/safe-equal";
import { recordCronRun } from "@/lib/platform/cron-runs";
import {
  listBulkDownloadFiles,
  downloadDeltaFile,
  scanDeltaZip,
  normalizeRegistration,
  type BulkFileInfo,
  type DeltaVehicleUpdate,
} from "@/lib/dvsa-bulk";
import { persistMotTests, type MotTestRow } from "@/lib/mot-history";

export const runtime = "nodejs";
export const maxDuration = 60;

// Nightly MOT delta sync. Downloads the DVSA daily delta files (full record
// for every GB/NI vehicle whose MOT data changed in the last 24h), matches
// registrations against our vehicles table and:
//   1. refreshes mot_expiry / last_mot_test_date without burning
//      per-registration API calls;
//   2. flags vehicles MOT'd with no booking or job here around the test date
//      (moted_elsewhere_at) — the lapsed-customer win-back signal.
// Each delta file is processed once (mot_delta_runs.filename is unique);
// unprocessed files left when the time budget runs out are picked up the
// next night. DELETED modifications are ignored — we never remove customer
// data on DVSA's say-so.

const TIME_BUDGET_MS = 45_000; // leave headroom inside maxDuration
const ELSEWHERE_WINDOW_DAYS = 7;

type VehicleRow = {
  id: string;
  location_id: string;
  organization_id: string;
  registration: string;
  mot_expiry: string | null;
  last_mot_test_date: string | null;
};

async function loadAllVehicles(admin: ReturnType<typeof createAdminClient>) {
  const byReg = new Map<string, VehicleRow[]>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from("vehicles")
      .select("id, location_id, organization_id, registration, mot_expiry, last_mot_test_date")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`vehicles page load failed: ${error.message}`);
    const rows = (data ?? []) as VehicleRow[];
    for (const row of rows) {
      const key = normalizeRegistration(row.registration);
      const list = byReg.get(key);
      if (list) list.push(row);
      else byReg.set(key, [row]);
    }
    if (rows.length < pageSize) break;
  }
  return byReg;
}

type PendingUpdate = {
  vehicle: VehicleRow;
  motExpiry: string | null;
  lastTestDate: string | null;
  /** true when the delta shows a test newer than what we had stored. */
  newTest: boolean;
};

function collectMatches(
  update: DeltaVehicleUpdate,
  byReg: Map<string, VehicleRow[]>,
  out: PendingUpdate[],
): number {
  if (update.modification === "DELETED") return 0;
  const rows = byReg.get(update.normalizedReg);
  if (!rows) return 0;

  for (const vehicle of rows) {
    const expiryChanged = update.motExpiry !== null && update.motExpiry !== vehicle.mot_expiry;
    const newTest =
      update.lastTestDate !== null &&
      (vehicle.last_mot_test_date === null || update.lastTestDate > vehicle.last_mot_test_date);
    if (!expiryChanged && !newTest) continue;
    out.push({
      vehicle,
      motExpiry: update.motExpiry,
      lastTestDate: update.lastTestDate,
      newTest,
    });
  }
  return rows.length;
}

// A vehicle was "MOT'd elsewhere" when the delta shows a new test but the
// garage has no booking or job for it within ±ELSEWHERE_WINDOW_DAYS of the
// test date. Both queries are batched across all candidates for the file.
async function findMotedElsewhere(
  admin: ReturnType<typeof createAdminClient>,
  candidates: PendingUpdate[],
): Promise<Set<string>> {
  const withTest = candidates.filter((c) => c.newTest && c.lastTestDate);
  if (withTest.length === 0) return new Set();

  const ids = [...new Set(withTest.map((c) => c.vehicle.id))];
  const earliest = withTest.reduce(
    (min, c) => (c.lastTestDate! < min ? c.lastTestDate! : min),
    withTest[0].lastTestDate!,
  );
  const windowStart = new Date(`${earliest}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - ELSEWHERE_WINDOW_DAYS);

  const [{ data: bookings, error: bErr }, { data: jobs, error: jErr }] = await Promise.all([
    admin
      .from("bookings")
      .select("vehicle_id, scheduled_at")
      .in("vehicle_id", ids)
      .gte("scheduled_at", windowStart.toISOString()),
    admin
      .from("jobs")
      .select("vehicle_id, created_at")
      .in("vehicle_id", ids)
      .gte("created_at", windowStart.toISOString()),
  ]);
  if (bErr) throw new Error(`bookings lookup failed: ${bErr.message}`);
  if (jErr) throw new Error(`jobs lookup failed: ${jErr.message}`);

  const activityByVehicle = new Map<string, string[]>();
  for (const row of [...(bookings ?? []), ...(jobs ?? [])] as {
    vehicle_id: string | null;
    scheduled_at?: string;
    created_at?: string;
  }[]) {
    if (!row.vehicle_id) continue;
    const at = (row.scheduled_at ?? row.created_at ?? "").slice(0, 10);
    if (!at) continue;
    const list = activityByVehicle.get(row.vehicle_id);
    if (list) list.push(at);
    else activityByVehicle.set(row.vehicle_id, [at]);
  }

  const windowMs = ELSEWHERE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const elsewhere = new Set<string>();
  for (const c of withTest) {
    const testMs = new Date(`${c.lastTestDate}T00:00:00Z`).getTime();
    const activity = activityByVehicle.get(c.vehicle.id) ?? [];
    const seenHere = activity.some(
      (d) => Math.abs(new Date(`${d}T00:00:00Z`).getTime() - testMs) <= windowMs,
    );
    if (!seenHere) elsewhere.add(c.vehicle.id);
  }
  return elsewhere;
}

async function processFile(
  admin: ReturnType<typeof createAdminClient>,
  file: BulkFileInfo,
  byReg: Map<string, VehicleRow[]>,
) {
  const t0 = Date.now();
  let scanned = 0;
  let matched = 0;
  const pending: PendingUpdate[] = [];
  const testRows: MotTestRow[] = [];

  try {
    const zip = await downloadDeltaFile(file);
    const result = await scanDeltaZip(zip, (update) => {
      matched += collectMatches(update, byReg, pending);
      // Persist the full test series for every matched vehicle (#596) — the
      // delta record is the complete history, and it only appears on the day
      // the vehicle's MOT data changed, so this is the cheap refresh moment.
      if (update.modification !== "DELETED" && update.tests.length > 0) {
        const rows = byReg.get(update.normalizedReg);
        if (rows) {
          for (const vehicle of rows) {
            for (const t of update.tests) {
              testRows.push({
                vehicle_id: vehicle.id,
                organization_id: vehicle.organization_id,
                test_date: t.testDate,
                result: t.result,
                odometer_miles: t.odometerMiles,
                defects: t.defects,
                source: "delta",
              });
            }
          }
        }
      }
    });
    scanned = result.scanned;

    const elsewhere = await findMotedElsewhere(admin, pending);

    const nowIso = new Date().toISOString();
    let updated = 0;
    for (const p of pending) {
      const patch: Record<string, string | null> = { mot_synced_at: nowIso };
      if (p.motExpiry !== null) patch.mot_expiry = p.motExpiry;
      if (p.lastTestDate !== null) patch.last_mot_test_date = p.lastTestDate;
      if (elsewhere.has(p.vehicle.id)) patch.moted_elsewhere_at = nowIso;
      const { error } = await admin.from("vehicles").update(patch).eq("id", p.vehicle.id);
      if (error) throw new Error(`vehicle update failed: ${error.message}`);
      updated++;
      // Keep the in-memory map current so later files in this run diff correctly.
      if (p.motExpiry !== null) p.vehicle.mot_expiry = p.motExpiry;
      if (p.lastTestDate !== null) p.vehicle.last_mot_test_date = p.lastTestDate;
    }

    // Enrichment, not correctness: a failed mot_tests write must not fail the
    // file (the expiry/win-back updates above already landed).
    const persisted = await persistMotTests(admin, testRows);

    await admin.from("mot_delta_runs").insert({
      filename: file.filename,
      file_created_on: file.fileCreatedOn || null,
      status: "done",
      scanned_count: scanned,
      matched_count: matched,
      updated_count: updated,
      moted_elsewhere_count: elsewhere.size,
      duration_ms: Date.now() - t0,
    });
    return { updated, elsewhere: elsewhere.size, tests: persisted.upserted, testsError: persisted.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from("mot_delta_runs").insert({
      filename: file.filename,
      file_created_on: file.fileCreatedOn || null,
      status: "error",
      scanned_count: scanned,
      matched_count: matched,
      error: message.slice(0, 500),
      duration_ms: Date.now() - t0,
    });
    throw err;
  }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !safeEqual(authHeader, `Bearer ${process.env.CRON_SECRET}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const __t0 = Date.now();

  let listing;
  try {
    listing = await listBulkDownloadFiles();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCronRun(admin, "cron/mot-delta", false, Date.now() - __t0, message.slice(0, 200));
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const { data: doneRows, error: doneErr } = await admin
    .from("mot_delta_runs")
    .select("filename")
    .eq("status", "done");
  if (doneErr) {
    return NextResponse.json({ error: doneErr.message }, { status: 500 });
  }
  const done = new Set((doneRows ?? []).map((r: { filename: string }) => r.filename));

  const pendingFiles = listing.delta
    .filter((f) => !done.has(f.filename))
    .sort((a, b) => a.fileCreatedOn.localeCompare(b.fileCreatedOn));

  if (pendingFiles.length === 0) {
    await recordCronRun(admin, "cron/mot-delta", true, Date.now() - __t0, "no new delta files");
    return NextResponse.json({ success: true, processed: 0 });
  }

  const byReg = await loadAllVehicles(admin);

  let processed = 0;
  let updated = 0;
  let elsewhere = 0;
  let tests = 0;
  let testsError: string | null = null;
  let failure: string | null = null;

  for (const file of pendingFiles) {
    if (Date.now() - __t0 > TIME_BUDGET_MS) break; // remaining files run next night
    try {
      const result = await processFile(admin, file, byReg);
      processed++;
      updated += result.updated;
      elsewhere += result.elsewhere;
      tests += result.tests;
      if (result.testsError) testsError = result.testsError;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      break; // keep ordering: don't skip a failed day's file
    }
  }

  const detail = `files ${processed}/${pendingFiles.length}, updated ${updated}, elsewhere ${elsewhere}, tests ${tests}${testsError ? `, tests error: ${testsError.slice(0, 80)}` : ""}${failure ? `, error: ${failure.slice(0, 120)}` : ""}`;
  await recordCronRun(admin, "cron/mot-delta", failure === null, Date.now() - __t0, detail);

  if (failure !== null) {
    return NextResponse.json({ error: failure, processed, updated }, { status: 502 });
  }
  return NextResponse.json({
    success: true,
    processed,
    pending: pendingFiles.length - processed,
    updated,
    moted_elsewhere: elsewhere,
    mot_tests_upserted: tests,
  });
}
