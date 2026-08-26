"use client";

import { useState, useTransition } from "react";
import { AigSpinner } from "@/components/ui/aig-spinner";
import { useConfirm } from "@/components/confirm-provider";
import { saveWheelProfile, addWheelServiceEvent, deleteWheelServiceEvent } from "./actions";

// Wheel & tyre profile + service history (#596). The profile answers "can
// this car's tyres be rotated at all?" (staggered/directional setups can't,
// or barely) — the recommendation engine refuses to suggest rotation until
// someone who has seen the car answers it. The events list is the cooldown
// anchor: no nagging about work done three weeks ago.

export type WheelProfile = {
  tyre_config: "standard" | "directional" | "staggered" | "unknown";
  notes: string | null;
} | null;

export type WheelServiceEvent = {
  id: string;
  service_type: "rotation" | "alignment" | "balance";
  performed_at: string;
  odometer_miles: number | null;
};

const CONFIG_OPTIONS = [
  { value: "unknown", label: "Unknown — not checked yet" },
  { value: "standard", label: "Standard (same size, non-directional)" },
  { value: "directional", label: "Directional tyres" },
  { value: "staggered", label: "Staggered (different sizes front/rear)" },
] as const;

const EVENT_LABELS: Record<WheelServiceEvent["service_type"], string> = {
  rotation: "Rotation",
  alignment: "Alignment",
  balance: "Balancing",
};

const INPUT =
  "rounded border border-black/20 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

export function WheelCareSection({
  vehicleId,
  customerId,
  profile,
  events,
}: {
  vehicleId: string;
  customerId: string;
  profile: WheelProfile;
  events: WheelServiceEvent[];
}) {
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [profileError, setProfileError] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  function handleProfileSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setProfileError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await saveWheelProfile(vehicleId, customerId, formData);
      if ("error" in result) setProfileError(result.error);
    });
  }

  function handleEventSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEventError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await addWheelServiceEvent(vehicleId, customerId, formData);
      if ("error" in result) setEventError(result.error);
      else setAddOpen(false);
    });
  }

  async function handleDelete(eventId: string) {
    const ok = await confirm({
      title: "Delete this wheel service record?",
      description: "The recommendation engine uses these to avoid re-suggesting recent work.",
      confirmLabel: "Delete record",
      destructive: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteWheelServiceEvent(eventId, vehicleId, customerId);
      if ("error" in result) setEventError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Profile */}
      <form onSubmit={handleProfileSubmit} className="flex flex-col gap-3">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ws-text-3">
          Wheel &amp; tyre profile
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Tyre configuration</label>
            <select
              name="tyre_config"
              defaultValue={profile?.tyre_config ?? "unknown"}
              disabled={pending}
              className={`${INPUT} w-64`}
            >
              {CONFIG_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5 grow">
            <label className="text-xs font-medium text-muted-foreground">Notes</label>
            <input
              name="notes"
              type="text"
              defaultValue={profile?.notes ?? ""}
              placeholder="e.g. 225/40 front, 255/35 rear"
              disabled={pending}
              className={INPUT}
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending && <AigSpinner />}
            Save profile
          </button>
        </div>
        {(profile?.tyre_config ?? "unknown") !== "standard" && (
          <p className="text-xs text-muted-foreground">
            {profile?.tyre_config === "staggered"
              ? "Staggered setups can't rotate front-to-rear — rotation won't be recommended."
              : profile?.tyre_config === "directional"
                ? "Directional tyres only rotate front-to-back on the same side — rotation won't be auto-recommended."
                : "Rotation recommendations stay held until the configuration is confirmed."}
          </p>
        )}
        {profileError && <p className="text-xs text-ws-red">{profileError}</p>}
      </form>

      {/* Service events */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ws-text-3">
            Wheel services
          </h3>
          <button
            type="button"
            onClick={() => setAddOpen(!addOpen)}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            {addOpen ? "Cancel" : "+ Record service"}
          </button>
        </div>

        {addOpen && (
          <form
            onSubmit={handleEventSubmit}
            className="rounded-lg border p-4 flex flex-wrap items-end gap-3 bg-muted/20"
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Service</label>
              <select name="service_type" disabled={pending} className={`${INPUT} w-40`}>
                <option value="rotation">Rotation</option>
                <option value="alignment">Alignment</option>
                <option value="balance">Balancing</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <input
                name="performed_at"
                type="date"
                defaultValue={new Date().toISOString().split("T")[0]}
                disabled={pending}
                className={`${INPUT} w-40`}
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
                placeholder="optional"
                disabled={pending}
                className={`${INPUT} w-32`}
              />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {pending && <AigSpinner />}
              Save
            </button>
          </form>
        )}

        {events.length === 0 && !addOpen ? (
          <p className="text-xs text-muted-foreground">
            No rotation, alignment or balancing recorded yet.
          </p>
        ) : events.length > 0 ? (
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-xs">Service</th>
                  <th className="px-3 py-2 font-medium text-xs">Date</th>
                  <th className="px-3 py-2 font-medium text-xs text-right">Miles</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} className="border-t">
                    <td className="px-3 py-2">{EVENT_LABELS[ev.service_type]}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {new Date(ev.performed_at).toLocaleDateString("en-GB")}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {ev.odometer_miles !== null ? ev.odometer_miles.toLocaleString("en-GB") : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(ev.id)}
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
          </div>
        ) : null}
        {eventError && <p className="text-xs text-ws-red">{eventError}</p>}
      </div>
    </div>
  );
}
