import "server-only";
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY && process.env.NODE_ENV === "production") {
  console.warn("[stripe] STRIPE_SECRET_KEY missing — payments features will fail at runtime.");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder", {
  apiVersion: "2026-07-29.dahlia",
  typescript: true,
});

// Platform fee skimmed from every customer-to-garage payment.
// Default 2% — override with STRIPE_PLATFORM_FEE_PERCENT in env, or pass a
// tier-specific percent (higher SaaS tiers pay a lower fee — see tenant-plans).
const PLATFORM_FEE_PERCENT = Number(process.env.STRIPE_PLATFORM_FEE_PERCENT ?? "2");

export function platformFeePence(totalPence: number, feePercent: number = PLATFORM_FEE_PERCENT): number {
  return Math.round((totalPence * feePercent) / 100);
}

const PUBLIC_ORIGIN =
  process.env.NEXT_PUBLIC_ROOT_DOMAIN && !process.env.NEXT_PUBLIC_ROOT_DOMAIN.includes("localtest")
    ? `https://${process.env.NEXT_PUBLIC_ROOT_DOMAIN}`
    : "https://ai-garage.co.uk";
const ROOT_HOST = PUBLIC_ORIGIN.replace(/^https?:\/\//, "");

export function publicOrigin(): string {
  return PUBLIC_ORIGIN;
}

// Origin for a specific tenant subdomain: https://{slug}.{rootHost}.
// Used for booking-flow Checkout success/cancel URLs so the user returns
// to their tenant context instead of landing on the apex domain.
export function tenantOrigin(slug: string): string {
  return `https://${slug}.${ROOT_HOST}`;
}

export function tenantPayUrl(invoiceId: string): string {
  return `${PUBLIC_ORIGIN}/pay/${invoiceId}`;
}
