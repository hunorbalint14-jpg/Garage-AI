"use client";

import { useState, useTransition } from "react";
import { AigSpinner } from "@/components/ui/aig-spinner";
import { setJobOdometer } from "../actions";

// Visit odometer (#596). Prompt-but-allow: amber nag while empty, one number
// box, no walls — this reading anchors the tyre-care mileage estimate.

export function OdometerSection({
  jobId,
  initialMiles,
}: {
  jobId: string;
  initialMiles: number | null;
}) {
  const [saved, setSaved] = useState(initialMiles);
  const [value, setValue] = useState(initialMiles === null ? "" : String(initialMiles));
  const [editing, setEditing] = useState(initialMiles === null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    const trimmed = value.trim();
    const miles = trimmed === "" ? null : parseInt(trimmed, 10);
    if (trimmed !== "" && (!Number.isInteger(miles) || miles! < 0)) {
      setError("Enter the mileage as a whole number.");
      return;
    }
    startTransition(async () => {
      const result = await setJobOdometer(jobId, miles);
      if ("error" in result) {
        setError(result.error);
      } else {
        setSaved(miles);
        setEditing(false);
      }
    });
  }

  return (
    <section className="rounded-lg border p-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ws-text-3">
            Odometer this visit
          </h2>
          {saved !== null && !editing ? (
            <p className="mt-1 text-sm font-mono">{saved.toLocaleString("en-GB")} miles</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Recorded mileage keeps service and tyre-care reminders honest.
            </p>
          )}
        </div>
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              placeholder="e.g. 45210"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={pending}
              className="w-32 rounded border border-black/20 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {pending && <AigSpinner />}
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            Edit
          </button>
        )}
      </div>

      {saved === null && !pending && (
        <p className="rounded-md border border-ws-amber-border bg-ws-amber-bg px-3 py-2 text-xs text-ws-amber">
          No odometer recorded for this visit yet — grab it while the car is in the bay.
        </p>
      )}
      {error && <p className="text-sm text-ws-red">{error}</p>}
    </section>
  );
}
