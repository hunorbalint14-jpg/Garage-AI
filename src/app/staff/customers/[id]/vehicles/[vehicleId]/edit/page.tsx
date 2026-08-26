import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffContext } from "@/lib/staff-context";
import { createAdminClient } from "@/lib/supabase/admin";
import { EditVehicleForm } from "./edit-vehicle-form";
import { TyreSection } from "../tyres/tyre-section";
import {
  WheelCareSection,
  type WheelProfile,
  type WheelServiceEvent,
} from "../tyres/wheel-care-section";

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

export default async function EditVehiclePage({
  params,
}: {
  params: Promise<{ id: string; vehicleId: string }>;
}) {
  const { id, vehicleId } = await params;
  const ctx = await requireStaffContext();
  const admin = createAdminClient();

  const [vehicleRes, tyresRes, profileRes, eventsRes] = await Promise.all([
    admin
      .from("vehicles")
      .select("id, registration, make, model, year, mot_expiry, service_due")
      .eq("id", vehicleId)
      .eq("customer_id", id)
      .eq("organization_id", ctx.organization.id)
      .maybeSingle(),
    admin
      .from("tyre_checks")
      .select("id, checked_at, nsf_depth, osf_depth, nsr_depth, osr_depth, nsf_replaced, osf_replaced, nsr_replaced, osr_replaced, odometer_miles, notes")
      .eq("vehicle_id", vehicleId)
      .order("checked_at", { ascending: false })
      .limit(20),
    admin
      .from("vehicle_wheel_profile")
      .select("tyre_config, notes")
      .eq("vehicle_id", vehicleId)
      .maybeSingle(),
    admin
      .from("wheel_service_events")
      .select("id, service_type, performed_at, odometer_miles")
      .eq("vehicle_id", vehicleId)
      .order("performed_at", { ascending: false })
      .limit(20),
  ]);

  if (!vehicleRes.data) notFound();
  const vehicle = vehicleRes.data;
  const tyreChecks = (tyresRes.data ?? []) as TyreCheck[];
  const wheelProfile = (profileRes.data ?? null) as WheelProfile;
  const wheelEvents = (eventsRes.data ?? []) as WheelServiceEvent[];

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div>
        <Link href={`/staff/customers/${id}`} className="text-sm text-muted-foreground underline">
          ← Back to customer
        </Link>
        <h1 className="text-2xl font-bold">Vehicle details</h1>
        <p className="text-sm text-muted-foreground font-mono">{vehicle.registration}</p>
      </div>

      <EditVehicleForm vehicle={vehicle} customerId={id} />

      <section className="rounded-lg border p-4 flex flex-col gap-3">
        <TyreSection vehicleId={vehicleId} customerId={id} checks={tyreChecks} />
      </section>

      <section className="rounded-lg border p-4 flex flex-col gap-3">
        <WheelCareSection
          vehicleId={vehicleId}
          customerId={id}
          profile={wheelProfile}
          events={wheelEvents}
        />
      </section>
    </div>
  );
}
