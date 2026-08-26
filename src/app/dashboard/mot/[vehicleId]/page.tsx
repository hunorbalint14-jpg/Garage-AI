import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle, XCircle, AlertTriangle, Gauge } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPortalContext } from "@/lib/portal-auth";
import { lookupMotHistory, type MotTest } from "@/lib/dvla";
import { motTestsToRows, persistMotTests } from "@/lib/mot-history";
import { cacheGet, cacheSet } from "@/lib/redis";
import { AnimatedBackground } from "@/components/animated-background";

// Full DVSA MOT history for one of the customer's vehicles. Customers check
// this on gov.uk anyway — surfacing it here keeps them in the garage's portal
// (and right next to the "book" button when an advisory needs fixing).

// MOT history changes at most once a year per vehicle — cache hard.
const MOT_CACHE_TTL_SEC = 24 * 60 * 60;

type CachedHistory = {
  registration: string;
  make: string | null;
  model: string | null;
  tests: MotTest[];
};

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const DEFECT_STYLE: Record<string, { label: string; cls: string }> = {
  DANGEROUS: { label: "Dangerous", cls: "bg-red-500/20 text-red-400" },
  MAJOR: { label: "Major", cls: "bg-red-500/20 text-red-400" },
  FAIL: { label: "Fail", cls: "bg-red-500/20 text-red-400" },
  MINOR: { label: "Minor", cls: "bg-amber-500/20 text-amber-400" },
  ADVISORY: { label: "Advisory", cls: "bg-amber-500/20 text-amber-400" },
};

export default async function MotHistoryPage({
  params,
}: {
  params: Promise<{ vehicleId: string }>;
}) {
  const { vehicleId } = await params;
  const { location, customer } = await getPortalContext();
  if (!customer) notFound();

  const admin = createAdminClient();
  const { data: vehicle } = await admin
    .from("vehicles")
    .select("id, registration, make, model, year, organization_id")
    .eq("id", vehicleId)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!vehicle) notFound();

  // DVSA quota is precious; history changes ~once a year. 24h Redis cache.
  const cacheKey = `mot-history:${vehicle.registration}`;
  let history = await cacheGet<CachedHistory>(cacheKey);
  let lookupFailed = false;
  if (!history) {
    const result = await lookupMotHistory(vehicle.registration);
    if (result.success) {
      history = {
        registration: result.registration,
        make: result.make,
        model: result.model,
        tests: result.tests,
      };
      await cacheSet(cacheKey, history, MOT_CACHE_TTL_SEC);
      // Write-through to mot_tests (#596) — the cache-miss fetch is the one
      // moment we hold the full series without spending extra DVSA quota.
      // Never blocks the page: persistMotTests swallows its own errors.
      await persistMotTests(
        admin,
        motTestsToRows(vehicle.id, vehicle.organization_id, result.tests, "lookup"),
      );
    } else {
      lookupFailed = true;
    }
  }

  const orgColor = location.organization.primary_color;
  const vehicleName =
    [vehicle.year, vehicle.make ?? history?.make, vehicle.model ?? history?.model]
      .filter(Boolean)
      .join(" ") || "Vehicle";

  return (
    <div className="relative min-h-screen bg-[#050c1a] text-white overflow-x-hidden">
      <AnimatedBackground brandColor={orgColor} />

      <main className="relative z-10 mx-auto max-w-2xl px-6 py-10 flex flex-col gap-8">
        <div>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back to dashboard
          </Link>
          <h1 className="mt-4 font-mono text-2xl font-bold tracking-widest">{vehicle.registration}</h1>
          <p className="mt-1 text-sm text-gray-400">{vehicleName} · MOT history</p>
        </div>

        {lookupFailed ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center text-sm text-gray-400 backdrop-blur-sm">
            MOT history isn&apos;t available right now. Please try again later.
          </div>
        ) : !history || history.tests.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center text-sm text-gray-400 backdrop-blur-sm">
            No MOT tests recorded yet — usually means the vehicle is under 3 years old.
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            {history.tests.map((test, i) => {
              const passed = test.testResult === "PASSED";
              const advisories = test.defects.filter((d) => d.type === "ADVISORY" || d.type === "MINOR");
              const failures = test.defects.filter((d) => d.type !== "ADVISORY" && d.type !== "MINOR");
              return (
                <li
                  key={`${test.completedDate}-${i}`}
                  className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      {passed ? (
                        <CheckCircle className="h-5 w-5 text-green-400" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-400" />
                      )}
                      <div>
                        <p className="text-sm font-semibold">
                          {passed ? "Passed" : "Failed"} · {formatDate(test.completedDate)}
                        </p>
                        {passed && test.expiryDate && (
                          <p className="text-xs text-gray-400">Expires {formatDate(test.expiryDate)}</p>
                        )}
                      </div>
                    </div>
                    {test.odometerValue && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 font-mono text-xs text-gray-300">
                        <Gauge className="h-3 w-3" />
                        {Number(test.odometerValue).toLocaleString("en-GB")} {test.odometerUnit?.toLowerCase() ?? "mi"}
                      </span>
                    )}
                  </div>

                  {(failures.length > 0 || advisories.length > 0) && (
                    <ul className="mt-3 flex flex-col gap-1.5 border-t border-white/5 pt-3">
                      {[...failures, ...advisories].map((d, j) => {
                        const style = DEFECT_STYLE[d.type] ?? DEFECT_STYLE.ADVISORY;
                        return (
                          <li key={j} className="flex items-start gap-2 text-xs text-gray-300">
                            <span className={`mt-px shrink-0 rounded-full px-2 py-0.5 font-medium ${style.cls}`}>
                              {style.label}
                            </span>
                            <span className="leading-relaxed">{d.text}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {history && history.tests.some((t) => t.defects.length > 0) && (
          <div
            className="rounded-2xl border p-5 text-sm backdrop-blur-sm"
            style={{ borderColor: `${orgColor}40`, backgroundColor: `${orgColor}10` }}
          >
            <p className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" style={{ color: orgColor }} />
              Advisories worth sorting before the next test?
            </p>
            <p className="mt-1 text-gray-300">
              Advisories often become failures by the following year.{" "}
              <Link href="/dashboard/book" className="font-semibold underline" style={{ color: orgColor }}>
                Book an appointment
              </Link>{" "}
              and we&apos;ll take a look.
            </p>
          </div>
        )}

        <p className="text-center text-xs text-gray-500">
          Data from the DVSA MOT history service. Updated daily.
        </p>
      </main>
    </div>
  );
}
