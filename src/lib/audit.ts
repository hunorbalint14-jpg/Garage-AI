import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

// Canonical action vocabulary. Adding a new value? Use the
// "<entity>.<verb>" pattern so future filtering stays sane.
export type AuditAction =
  // Org / location settings
  | "settings.update"
  | "settings.vat"
  | "inspection.start"
  | "inspection.complete"
  | "inspection.ai_summaries"
  | "inspection.quote_created"
  | "inspection.send"
  | "inspection.view"
  | "inspection.respond"
  | "deferred.followup_sent"
  | "deferred.recovered"
  | "deferred.dismissed"
  | "deferred.reopened"
  | "authorisation.captured"
  | "authorisation.reauth_requested"
  | "authorisation.reauth_responded"
  | "account.updated"
  | "invoice.consolidated"
  | "payment.recorded"
  | "statement.sent"
  | "setup_checklist.dismissed"
  | "demo.seeded"
  | "demo.wiped"
  | "import.committed"
  | "site.published"
  | "site.unpublished"
  | "site.updated"
  | "settings.ai_profile_update"
  | "settings.business_hours_update"
  | "settings.special_hours_add"
  | "settings.special_hours_remove"
  | "settings.logo_upload"
  | "settings.location_add"
  | "settings.location_rename"
  | "settings.location_set_primary"
  // Stripe Connect
  | "stripe.connect_start"
  | "stripe.connect_complete"
  | "stripe.dashboard_open"
  | "stripe.status_refresh"
  // Accounting (Xero / QuickBooks). Older rows carry the legacy
  // xero.connect_complete / xero.disconnect action names.
  | "accounting.connect_complete"
  | "accounting.disconnect"
  | "accounting.retry_sync"
  // Compliance
  | "dpa.accept"
  | "impersonation.start"
  | "impersonation.stop"
  // Doc shares
  | "doc_share.mint"
  | "doc_share.revoke"
  // Auth lifecycle
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.mfa_verified"
  // Platform operators (cross-tenant)
  | "platform_admin.invite"
  | "platform_admin.revoke"
  | "location.slug_change"
  | "org.slug_change"
  | "org.data_export"
  // Platform reliability incidents
  | "incident.declare"
  | "incident.update"
  | "incident.resolve"
  | "incident.publish"
  | "incident.ack"
  | "alert.toggle"
  | "alert.test"
  | "feature_flag.set"
  // Scheduling / labour (Phase 3)
  | "booking.assign"
  | "booking.move"
  | "job.assign"
  | "job.clock_in"
  | "job.clock_out"
  | "job.clock_pause"
  | "job.clock_resume"
  | "job.time_adjust"
  | "job.odometer_set"
  // Passkeys
  | "passkey.register"
  | "passkey.revoke"
  // Customers (GDPR-sensitive)
  | "customer.create"
  | "customer.update"
  | "customer.delete"
  | "customer.hard_delete"
  | "customer.anonymize"
  | "customer.consent_update"
  | "customer.data_export"
  // Vehicles
  | "vehicle.create"
  | "vehicle.delete"
  | "vehicle.wheel_profile_update"
  | "vehicle.wheel_service_recorded"
  | "vehicle.wheel_service_deleted"
  // Invoices (financial)
  | "invoice.create"
  | "invoice.send"
  | "invoice.mark_paid"
  | "invoice.delete"
  | "invoice.dunning_sent"
  | "invoice.refund"
  | "credit_note.create"
  // Reviews
  | "review.requested"
  | "review.submitted"
  // Services / products (pricing trail)
  | "service.upsert"
  | "service.toggle_active"
  | "service.delete"
  // Service plans (recurring memberships)
  | "service_plan.upsert"
  | "service_plan.delete"
  | "plan.subscribe"
  | "plan.cancel"
  | "plan.invite_sent"
  | "plan.benefits_start_override"
  // SaaS tenant billing
  | "tenant.subscribe"
  | "tenant.cancel"
  | "product.create"
  | "product.update"
  | "product.delete"
  | "product.stock_adjust"
  // Suppliers & purchase orders
  | "supplier.create"
  | "supplier.update"
  | "supplier.delete"
  | "location.go_live"
  | "location.first_run_policy"
  | "supplier_integration.update"
  | "supplier_integration.delete"
  | "purchase_order.create"
  | "purchase_order.update"
  | "purchase_order.receive"
  | "purchase_order.delete"
  | "purchase_order.send"
  | "purchase_order.confirmation_import"
  // Staff access management
  | "staff.invite"
  | "staff.password_reset"
  | "staff.password_set"
  | "staff.mfa_reset"
  | "staff.permissions_update"
  | "staff.role_change"
  | "staff.remove"
  | "staff.template_assign"
  | "staff.mot_flag_change"
  | "staff.location_access_grant"
  // Role templates
  | "role_template.create"
  | "role_template.update"
  | "role_template.delete"
  // Communications (spam / abuse trail)
  | "reminder.send"
  | "campaign.send"
  | "message.send"
  | "winback.send"
  | "winback.dismiss"
  // Customer finance (Bumper / Payment Assist)
  | "finance.application_start"
  | "finance.application_completed"
  | "finance.invoice_settled"
  | "finance.config_update"
  // AI receptionist
  | "receptionist.booking_created"
  | "receptionist.handed_off"
  | "receptionist.number_provisioned"
  | "receptionist.number_released"
  | "receptionist.config_update"
  // No-show defence
  | "booking.no_show_charged"
  | "booking.no_show_charge_failed"
  // Courtesy cars
  | "courtesy_car.create"
  | "courtesy_car.update"
  | "courtesy_car.checkout"
  | "courtesy_car.return"
  // EV / SERMI readiness
  | "ev.sermi_update"
  | "ev.qual_update"
  | "job.high_voltage_toggle"
  // DVI / mid-job upsell quotes
  | "quote.create"
  | "quote.send"
  | "quote.cancel"
  | "quote.view"
  | "quote.approve"
  | "quote.decline"
  | "quote.rebook"
  | "quote.expire"
  | "quote.deposit_paid"
  | "quote.revise"
  | "quote.reminder_sent"
  | "quote.converted_to_booking"
  // Standalone (pre-job) quotes
  | "standalone_quote.create"
  | "standalone_quote.send"
  | "standalone_quote.cancel"
  | "standalone_quote.view"
  | "standalone_quote.approve"
  | "standalone_quote.decline"
  | "standalone_quote.expire"
  | "standalone_quote.deposit_paid"
  // Support tickets (platform <-> garage)
  | "ticket.create"
  | "ticket.reply"
  | "ticket.internal_note"
  | "ticket.status_change"
  | "ticket.priority_change";

type LogArgs = {
  organizationId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  /** Explicit IP address — use when calling from edge middleware where next/headers() is unavailable. */
  ipAddress?: string | null;
  /** Explicit user-agent — use when calling from edge middleware where next/headers() is unavailable. */
  userAgent?: string | null;
};

// Fire-and-forget audit write. Never throws — failures only log to stderr
// so the caller's main path can't be broken by an audit-table issue.
export async function logAudit(args: LogArgs): Promise<void> {
  try {
    const admin = createAdminClient();
    // Prefer caller-supplied IP/UA (required for edge middleware where
    // headers() is unavailable); fall back to reading request headers.
    let ip: string | null = args.ipAddress ?? null;
    let ua: string | null = args.userAgent ?? null;
    if (ip === null && ua === null) {
      try {
        const h = await headers();
        ip =
          h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          h.get("x-real-ip") ??
          null;
        ua = h.get("user-agent") ?? null;
      } catch {
        // headers() throws outside a request context — acceptable for cron,
        // webhook, and edge-middleware callers that pass ip/ua explicitly.
      }
    }
    await admin.from("audit_log").insert({
      organization_id: args.organizationId ?? null,
      actor_user_id: args.actorUserId ?? null,
      actor_email: args.actorEmail ?? null,
      action: args.action,
      entity_type: args.entityType ?? null,
      entity_id: args.entityId ?? null,
      metadata: args.metadata ?? {},
      ip_address: ip,
      user_agent: ua,
    });
  } catch (err) {
    console.error("[audit] log failed", { action: args.action, err });
  }
}
