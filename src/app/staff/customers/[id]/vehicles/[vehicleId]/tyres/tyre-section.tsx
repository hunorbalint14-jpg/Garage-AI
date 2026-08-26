"use client";

import { useState, useTransition } from "react";
import { AigSpinner } from "@/components/ui/aig-spinner";
import { saveTyreCheck, deleteTyreCheck } from "./actions";
import { useConfirm } from "@/components/confirm-provider";

type TyreCheck = {
  id: string;
  checked_at: string;
  nsf_depth: number | null;
  osf_depth: number | null;
  nsr_depth: number | null;
  osr_depth: number | null;
  nsf_replaced: boolean;
  osf_replaced: boolean;
  nsr_replaced: boolean;
  osr_replaced: boolean;
  odometer_miles: number | null;
  notes: string | null;
};

type Props = {
  vehicleId: string;
  customerId: string;
  checks: TyreCheck[];
};

const LEGAL_MIN = 1.6;
const WARN_MIN = 3.0;

function depthColor(d: number | null): string {
  if (d === null) return "text-muted-foreground";
  if (d <= LEGAL_MIN) return "text-ws-red font-bold";
  if (d <= WARN_MIN) return "text-ws-amber font-medium";
  return "text-ws-green";
}

function depthBadge(d: number | null, replaced: boolean) {
  if (replaced) return <span className="text-xs rounded-full bg-ws-blue-bg text-ws-blue px-2 py-0.5">Replaced</span>;
  if (d === null) return <span className="text-muted-foreground">—</span>;
  return <span className={depthColor(d)}>{d}mm{d <= LEGAL_MIN ? " ⚠️" : ""}</span>;
}

const INPUT = "w-20 rounded border border-black/20 bg-transparent px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-ring";

export function TyreSection({ vehicleId, customerId, checks }: Props) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await saveTyreCheck(vehicleId, customerId, formData);
      if ("error" in result) setError(result.error);
      else setOpen(false);
    });
  }

  async function handleDelete(checkId: string) {
    const ok = await confirm({
      title: "Delete this tyre check?",
      description: "The recorded tread depths and notes are removed.",
      confirmLabel: "Delete check",
      destructive: true,
    });
    if (!ok) return;
    startTransition(async () => {
      await deleteTyreCheck(checkId, vehicleId, customerId);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ws-text-3">Tyre checks</h3>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-xs underline text-muted-foreground hover:text-foreground"
        >
          {open ? "Cancel" : "+ Add check"}
        </button>
      </div>

      {/* Add form */}
      {open && (
        <form onSubmit={handleSubmit} className="rounded-lg border p-4 flex flex-col gap-4 bg-muted/20">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <input
                name="checkedAt"
                type="date"
                defaultValue={new Date().toISOString().split("T")[0]}
                disabled={pending}
                className="w-40 rounded border border-black/20 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Mileage</label>
              <input
                name="odometer_miles"
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                placeholder="e.g. 45210"
                disabled={pending}
                className="w-32 rounded border border-black/20 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-2 pr-4">Position</th>
                  <th className="text-center text-xs font-medium text-muted-foreground pb-2 pr-3">Tread (mm)</th>
                  <th className="text-center text-xs font-medium text-muted-foreground pb-2">Replaced?</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[
                  { label: "Nearside front", name: "nsf" },
                  { label: "Offside front", name: "osf" },
                  { label: "Nearside rear", name: "nsr" },
                  { label: "Offside rear", name: "osr" },
                ].map((pos) => (
                  <tr key={pos.name}>
                    <td className="py-2 pr-4 text-sm">{pos.label}</td>
                    <td className="py-2 pr-3 text-center">
                      <input
                        name={`${pos.name}_depth`}
                        type="number"
                        step="0.1"
                        min="0"
                        max="12"
                        placeholder="—"
                        disabled={pending}
                        className={INPUT}
                      />
                    </td>
                    <td className="py-2 text-center">
                      <input type="checkbox" name={`${pos.name}_replaced`} disabled={pending} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Notes</label>
            <input
              name="notes"
              type="text"
              placeholder="e.g. advised 2 new fronts within 1 month"
              disabled={pending}
              className="rounded border border-black/20 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {error && <p className="text-xs text-ws-red">{error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center justify-center gap-1.5 self-start rounded-lg border border-transparent bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending && <AigSpinner />}
            Save tyre check
          </button>
        </form>
      )}

      {/* History */}
      {checks.length === 0 && !open ? (
        <p className="text-xs text-muted-foreground">No tyre checks recorded yet.</p>
      ) : checks.length > 0 ? (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium text-xs">Date</th>
                <th className="px-3 py-2 font-medium text-xs text-center">NSF</th>
                <th className="px-3 py-2 font-medium text-xs text-center">OSF</th>
                <th className="px-3 py-2 font-medium text-xs text-center">NSR</th>
                <th className="px-3 py-2 font-medium text-xs text-center">OSR</th>
                <th className="px-3 py-2 font-medium text-xs text-right">Miles</th>
                <th className="px-3 py-2 font-medium text-xs">Notes</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                    {new Date(c.checked_at).toLocaleDateString("en-GB")}
                  </td>
                  <td className="px-3 py-2 text-center">{depthBadge(c.nsf_depth, c.nsf_replaced)}</td>
                  <td className="px-3 py-2 text-center">{depthBadge(c.osf_depth, c.osf_replaced)}</td>
                  <td className="px-3 py-2 text-center">{depthBadge(c.nsr_depth, c.nsr_replaced)}</td>
                  <td className="px-3 py-2 text-center">{depthBadge(c.osr_depth, c.osr_replaced)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                    {c.odometer_miles !== null ? c.odometer_miles.toLocaleString("en-GB") : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground max-w-[160px] truncate">{c.notes ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(c.id)}
                      disabled={pending}
                      className="text-xs text-muted-foreground hover:text-ws-red transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-muted-foreground border-t">
            Legal min: <span className="text-ws-red font-medium">1.6mm</span> · Advisory below: <span className="text-ws-amber font-medium">3mm</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}
