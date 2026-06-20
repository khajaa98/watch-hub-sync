/**
 * src/app/(app)/billing/page.tsx
 *
 * Billing & Plan page — Server Component.
 * Fetches the user's current subscription tier from Supabase and renders
 * either the upgrade flow (Free) or the management panel (Premium).
 *
 * Success / cancel state from Stripe Checkout is surfaced via searchParams.
 */

import { redirect } from "next/navigation";
import {
  Crown,
  Sparkles,
  Check,
  Zap,
  Tv2,
  Users,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";
import { createSupabaseServerComponentClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { CheckoutButton } from "./_components/checkout-button";
import type { UserRow } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata = { title: "Billing · Watch Hub Sync" };

// ---------------------------------------------------------------------------
// Feature grid data
// ---------------------------------------------------------------------------

const FREE_FEATURES = [
  { icon: Tv2,        label: "1 active watch room" },
  { icon: Users,      label: "Up to 4 viewers" },
  { icon: Zap,        label: "720p sync quality" },
];

const PREMIUM_FEATURES = [
  { icon: Tv2,        label: "Unlimited watch rooms" },
  { icon: Users,      label: "Up to 50 viewers per room" },
  { icon: Zap,        label: "1080p HD sync quality" },
  { icon: ShieldCheck,label: "Priority support" },
  { icon: Sparkles,   label: "Early access to new features" },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FeatureItem({
  icon: Icon,
  label,
  muted = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  muted?: boolean;
}) {
  return (
    <li className="flex items-center gap-2.5">
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          muted
            ? "bg-white/[0.04] text-neutral-600"
            : "bg-violet-500/10 text-violet-400",
        )}
      >
        <Check className="h-3 w-3" strokeWidth={2.5} />
      </span>
      <span className={cn("text-sm", muted ? "text-neutral-600" : "text-neutral-300")}>
        <Icon className="mr-1.5 inline h-3.5 w-3.5 opacity-60" />
        {label}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface BillingPageProps {
  readonly searchParams: Record<string, string | string[] | undefined>;
}

export default async function BillingPage({ searchParams }: BillingPageProps) {
  const supabase = createSupabaseServerComponentClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profileRaw } = await supabase
    .from("users")
    .select("display_name, subscription_tier")
    .eq("id", user.id)
    .single();

  const profile = profileRaw as unknown as Pick<
    UserRow,
    "display_name" | "subscription_tier"
  > | null;

  const isPremium = profile?.subscription_tier === "premium";

  // Stripe redirects back with ?checkout=success or ?checkout=cancelled
  const checkoutParam =
    typeof searchParams["checkout"] === "string"
      ? searchParams["checkout"]
      : undefined;

  return (
    <main className="min-h-dvh bg-zinc-950 px-4 pb-20 pt-12">
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-2xl">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-neutral-600">
          <Crown className="h-3.5 w-3.5" />
          <span>Billing</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          {isPremium ? "Your Plan" : "Upgrade Your Experience"}
        </h1>
        <p className="mt-1.5 text-sm text-neutral-500">
          {isPremium
            ? "You're on the Premium plan. Enjoy all features."
            : "Get unlimited rooms, more viewers, and HD sync quality."}
        </p>

        {/* ── Checkout status banners ──────────────────────────────────── */}
        {checkoutParam === "success" && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-400">
            <Check className="h-4 w-4 shrink-0" strokeWidth={2.5} />
            <span>Payment successful — welcome to Premium! Your plan is now active.</span>
          </div>
        )}
        {checkoutParam === "cancelled" && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-yellow-500/20 bg-yellow-500/[0.06] px-4 py-3 text-sm text-yellow-400">
            <span>Checkout was cancelled. No charge has been made.</span>
          </div>
        )}

        {/* ── Plan cards ──────────────────────────────────────────────── */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {/* Free card */}
          <div
            className={cn(
              "flex flex-col rounded-2xl border p-6 transition-all",
              isPremium
                ? "border-white/[0.06] bg-white/[0.02]"
                : "border-white/10 bg-white/[0.03]",
            )}
          >
            <div className="mb-4">
              <p className="text-xs font-medium uppercase tracking-widest text-neutral-600">
                Free
              </p>
              <p className="mt-2 text-3xl font-bold text-white">
                £0
                <span className="ml-1 text-base font-normal text-neutral-500">/mo</span>
              </p>
            </div>

            <ul className="flex flex-1 flex-col gap-2.5">
              {FREE_FEATURES.map((f) => (
                <FeatureItem
                  key={f.label}
                  icon={f.icon}
                  label={f.label}
                  muted={isPremium}
                />
              ))}
            </ul>

            {!isPremium && (
              <div className="mt-6">
                <span className="inline-flex items-center rounded-lg border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-sm text-neutral-500">
                  Current plan
                </span>
              </div>
            )}
          </div>

          {/* Premium card */}
          <div
            className={cn(
              "relative flex flex-col overflow-hidden rounded-2xl border p-6 transition-all",
              isPremium
                ? "border-violet-500/40 bg-violet-950/30"
                : "border-violet-500/30 bg-white/[0.02]",
            )}
          >
            {/* Ambient violet glow */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-px rounded-2xl"
              style={{
                background:
                  "radial-gradient(ellipse 80% 60% at 50% -20%, rgba(139,92,246,0.15), transparent)",
              }}
            />

            {isPremium && (
              <div className="absolute right-4 top-4 flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-violet-400">
                <Crown className="h-2.5 w-2.5" />
                Active
              </div>
            )}

            <div className="relative mb-4">
              <p className="text-xs font-medium uppercase tracking-widest text-violet-400">
                Premium
              </p>
              <p className="mt-2 text-3xl font-bold text-white">
                £4.99
                <span className="ml-1 text-base font-normal text-neutral-500">/mo</span>
              </p>
            </div>

            <ul className="relative flex flex-1 flex-col gap-2.5">
              {PREMIUM_FEATURES.map((f) => (
                <FeatureItem key={f.label} icon={f.icon} label={f.label} />
              ))}
            </ul>

            <div className="relative mt-6">
              {isPremium ? (
                // Stub — wire to Stripe Customer Portal later
                <button
                  type="button"
                  disabled
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-neutral-400 opacity-60"
                  title="Stripe Customer Portal — coming soon"
                >
                  <ExternalLink className="h-4 w-4" />
                  Manage Subscription
                </button>
              ) : (
                <CheckoutButton />
              )}
            </div>
          </div>
        </div>

        {/* ── Fine print ──────────────────────────────────────────────── */}
        {!isPremium && (
          <p className="mt-6 text-center text-xs text-neutral-700">
            Secure checkout powered by Stripe. Cancel anytime. Prices shown in GBP.
          </p>
        )}
      </div>
    </main>
  );
}
