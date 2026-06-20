/**
 * src/app/api/billing/checkout/route.ts
 *
 * POST /api/billing/checkout — Create a Stripe Checkout Session.
 *
 * Security:
 *   - Requires an authenticated Supabase session (requireUser → network-verified).
 *   - The authenticated user.id is embedded as client_reference_id and in
 *     metadata so the webhook can attribute the payment without trusting
 *     any client-supplied data.
 *
 * Flow:
 *   Client clicks "Upgrade →"
 *     → POST /api/billing/checkout
 *       → stripe.checkout.sessions.create()
 *         → { url } returned to client
 *           → client redirects browser to Stripe-hosted checkout
 *             → payment → checkout.session.completed webhook
 *               → user upgraded to premium
 *
 * Returns:
 *   200 { url: string }   — Stripe Checkout URL; client should redirect there
 *   401                   — unauthenticated
 *   409                   — user is already premium
 *   500                   — Stripe API or DB error
 */

import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import {
  requireUser,
  AuthRequiredError,
  createSupabaseRouteHandlerClient,
} from "@/lib/supabase/server";
import { getStripeClient, getStripeEnv } from "@/lib/billing/stripe-client";
import { createLogger } from "@/lib/logger";
import type { UserRow } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Route config — Node.js required for Stripe SDK
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger({ module: "api/billing/checkout" });

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface CheckoutResponse {
  readonly url: string;
}

interface ErrorResponse {
  readonly error: string;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
): Promise<NextResponse<CheckoutResponse | ErrorResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  let userId: string;
  let userEmail: string | undefined;

  try {
    const user = await requireUser();
    userId    = user.id;
    userEmail = user.email;
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return NextResponse.json<ErrorResponse>(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    throw err;
  }

  // ── 2. Guard: skip if already premium ────────────────────────────────────
  const supabase = createSupabaseRouteHandlerClient();

  const { data: profileRaw } = await supabase
    .from("users")
    .select("subscription_tier, stripe_customer_id")
    .eq("id", userId)
    .single();
  const profile = profileRaw as unknown as Pick<
    UserRow,
    "subscription_tier" | "stripe_customer_id"
  > | null;

  if (profile?.subscription_tier === "premium") {
    log.info({ userId }, "Checkout blocked — user already premium");
    return NextResponse.json<ErrorResponse>(
      { error: "You are already on the Premium plan." },
      { status: 409 },
    );
  }

  // ── 3. Determine redirect origin ──────────────────────────────────────────
  // Prefer the canonical app URL (env var) over request origin so redirects
  // always land on the primary domain in production.
  const appUrl =
    process.env["NEXT_PUBLIC_APP_URL"]?.replace(/\/$/, "") ??
    new URL(request.url).origin;

  const successUrl = `${appUrl}/billing?checkout=success`;
  const cancelUrl  = `${appUrl}/billing?checkout=cancelled`;

  // ── 4. Create Stripe Checkout Session ────────────────────────────────────
  try {
    // getStripeClient/getStripeEnv throw if env vars are missing — keep inside
    // the try so we can catch and return a diagnostic 500 (not an unhandled crash).
    const stripe           = getStripeClient();
    const { pricePremium } = getStripeEnv();

    // Build params mutably to avoid conditional spread creating a union type
    // that confuses TypeScript's overload resolution on sessions.create().
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",

      line_items: [
        {
          price:    pricePremium,
          quantity: 1,
        },
      ],

      // ── CRITICAL: attribute this purchase to the authenticated user ──────
      // The webhook handler reads client_reference_id to know which user
      // to upgrade. Without this field the payment cannot be attributed.
      client_reference_id: userId,

      // Metadata is included in all Stripe Dashboard views and webhook payloads.
      // Redundant with client_reference_id — belt-and-suspenders for ops triage.
      metadata: {
        user_id:  userId,
        app:      "watchhubsync",
        plan:     "premium",
      },

      // Allow promo codes entered in Stripe checkout (optional; remove if not needed)
      allow_promotion_codes: true,

      // Redirect URLs — must be absolute
      success_url: successUrl,
      cancel_url:  cancelUrl,

      // Automatic tax collection via Stripe Tax (requires Stripe Tax enabled in dashboard)
      // automatic_tax: { enabled: true },
    };

    // Pre-fill customer details — set separately to keep params type clean.
    if (
      profile?.stripe_customer_id !== null &&
      profile?.stripe_customer_id !== undefined
    ) {
      // Link existing Stripe customer so saved cards appear in checkout.
      sessionParams.customer = profile.stripe_customer_id;
    } else if (userEmail !== undefined) {
      // Pre-fill the email field in Stripe's hosted checkout UI.
      sessionParams.customer_email = userEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    if (session.url === null || session.url.trim().length === 0) {
      log.error({ userId, sessionId: session.id }, "Stripe returned session with null URL");
      return NextResponse.json<ErrorResponse>(
        { error: "Failed to create checkout session" },
        { status: 500 },
      );
    }

    log.info(
      {
        userId,
        sessionId:   session.id,
        priceId:     pricePremium,
        successUrl,
        cancelUrl,
      },
      "Stripe Checkout Session created",
    );

    return NextResponse.json<CheckoutResponse>(
      { url: session.url },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ err, userId, errMsg }, "Stripe Checkout Session creation failed");
    // Include the real error message in the response so it shows in the UI
    // and helps diagnose — strip before go-live if preferred.
    return NextResponse.json<ErrorResponse>(
      { error: `Checkout error: ${errMsg}` },
      { status: 500 },
    );
  }
}
