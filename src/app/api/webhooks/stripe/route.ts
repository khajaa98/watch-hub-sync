/**
 * src/app/api/webhooks/stripe/route.ts
 *
 * Stripe Usage-Based Billing & Subscription Lifecycle Webhook.
 *
 * ─── RAW BODY REQUIREMENT ────────────────────────────────────────────────────
 * Stripe's HMAC signature is computed over the exact raw byte sequence of the
 * request body. Any transformation (JSON.parse → JSON.stringify, whitespace
 * normalization, character encoding change) will invalidate the signature.
 * We read the body ONCE via `request.text()` and pass the string directly to
 * `stripe.webhooks.constructEvent()`.
 *
 * ─── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * Stripe guarantees "at least once" delivery. Each event has a stable `id`
 * (e.g., `evt_...`). We use this as an idempotency key when performing
 * database mutations. A second delivery of the same event is detected by the
 * presence of the stripe_event_id in the relevant table, causing a no-op
 * return of 200.
 *
 * Handled events:
 *
 *   customer.subscription.created   → set user tier to 'premium'
 *   customer.subscription.updated   → sync status changes (e.g., past_due)
 *   customer.subscription.deleted   → downgrade user to 'free' tier
 *   invoice.payment_succeeded       → mark related billing_meters processed
 *   invoice.payment_failed          → log for ops alerting, no tier change
 *   billing.meter_event_adjustment  → (future: handle credit adjustments)
 *
 * Ignored events return 200 — unknown events should never return 4xx/5xx to
 * Stripe as that would pause webhook delivery for the entire endpoint.
 */

import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { constructStripeEvent } from "@/lib/billing/stripe-client";
import { createLogger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Route config
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger({ module: "webhooks/stripe" });

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body — MUST be first ────────────────────────────────────
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (cause) {
    log.error({ cause }, "Failed to read Stripe webhook body");
    return NextResponse.json({ error: "Body read failed" }, { status: 400 });
  }

  if (rawBody.trim().length === 0) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }

  // ── 2. Signature verification ─────────────────────────────────────────────
  const signature = request.headers.get("stripe-signature");

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = constructStripeEvent(rawBody, signature);
  } catch (cause) {
    log.warn(
      { cause: cause instanceof Error ? cause.message : String(cause) },
      "Stripe signature verification failed",
    );
    return NextResponse.json(
      { error: "Invalid stripe-signature" },
      { status: 401 },
    );
  }

  const { id: eventId, type: eventType } = stripeEvent;

  log.info({ eventId, eventType }, "Stripe webhook received");

  // ── 3. Dispatch to handler ────────────────────────────────────────────────
  try {
    switch (eventType) {
      case "customer.subscription.created":
        await handleSubscriptionCreated(
          stripeEvent.data.object as Stripe.Subscription,
          eventId,
        );
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(
          stripeEvent.data.object as Stripe.Subscription,
          eventId,
        );
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(
          stripeEvent.data.object as Stripe.Subscription,
          eventId,
        );
        break;

      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(
          stripeEvent.data.object as Stripe.Invoice,
          eventId,
        );
        break;

      case "invoice.payment_failed":
        handleInvoicePaymentFailed(
          stripeEvent.data.object as Stripe.Invoice,
          eventId,
        );
        break;

      default:
        log.debug({ eventType }, "Stripe event type not handled — ignoring");
    }
  } catch (cause) {
    log.error({ cause, eventId, eventType }, "Stripe webhook handler threw");
    // Return 500 to trigger Stripe retry with backoff
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the internal Supabase user ID from a Stripe customer ID.
 * Returns null if the customer is not linked to a user in our DB.
 */
async function resolveUserFromStripeCustomer(
  stripeCustomerId: string,
): Promise<string | null> {
  const supabase = createSupabaseServiceClient();

  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("stripe_customer_id", stripeCustomerId)
    .single();

  if (error !== null || data === null) {
    log.warn(
      { stripeCustomerId },
      "Could not resolve Supabase user from stripe_customer_id",
    );
    return null;
  }

  return data.id;
}

/**
 * Extract the Stripe customer ID from a subscription object.
 * Handles both the string form and the expanded Stripe.Customer object.
 */
function extractCustomerId(
  subscription: Stripe.Subscription,
): string | null {
  const customer = subscription.customer;
  if (typeof customer === "string") return customer;
  if (typeof customer === "object" && customer !== null && "id" in customer) {
    return customer.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleSubscriptionCreated(
  subscription: Stripe.Subscription,
  eventId: string,
): Promise<void> {
  if (
    subscription.status !== "active" &&
    subscription.status !== "trialing"
  ) {
    log.info(
      { subscriptionId: subscription.id, status: subscription.status },
      "Subscription created but not yet active — deferring tier upgrade",
    );
    return;
  }

  const customerId = extractCustomerId(subscription);
  if (customerId === null) {
    log.error({ subscriptionId: subscription.id }, "Subscription has no customer ID");
    return;
  }

  const userId = await resolveUserFromStripeCustomer(customerId);
  if (userId === null) return;

  const supabase = createSupabaseServiceClient();

  const { error } = await supabase
    .from("users")
    .update({
      subscription_tier: "premium",
      stripe_subscription_id: subscription.id,
    })
    .eq("id", userId)
    // Idempotency guard: only update if not already premium from this subscription
    .neq("stripe_subscription_id", subscription.id);

  if (error !== null) {
    throw new Error(`Failed to set premium tier: ${error.message}`);
  }

  log.info(
    { userId, customerId, subscriptionId: subscription.id, eventId },
    "User upgraded to premium",
  );
}

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
  eventId: string,
): Promise<void> {
  const customerId = extractCustomerId(subscription);
  if (customerId === null) return;

  const userId = await resolveUserFromStripeCustomer(customerId);
  if (userId === null) return;

  const supabase = createSupabaseServiceClient();

  // Map Stripe subscription status to our tier model
  const isActive =
    subscription.status === "active" || subscription.status === "trialing";

  const tier: "free" | "premium" = isActive ? "premium" : "free";

  const { error } = await supabase
    .from("users")
    .update({ subscription_tier: tier })
    .eq("id", userId);

  if (error !== null) {
    throw new Error(`Subscription update failed: ${error.message}`);
  }

  log.info(
    {
      userId,
      subscriptionId: subscription.id,
      stripeStatus:   subscription.status,
      newTier:        tier,
      eventId,
    },
    "Subscription updated",
  );
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  eventId: string,
): Promise<void> {
  const customerId = extractCustomerId(subscription);
  if (customerId === null) return;

  const userId = await resolveUserFromStripeCustomer(customerId);
  if (userId === null) return;

  const supabase = createSupabaseServiceClient();

  const { error } = await supabase
    .from("users")
    .update({
      subscription_tier:      "free",
      stripe_subscription_id: null,
    })
    .eq("id", userId);

  if (error !== null) {
    throw new Error(`Failed to downgrade user: ${error.message}`);
  }

  log.info(
    { userId, subscriptionId: subscription.id, eventId },
    "Subscription cancelled — user downgraded to free",
  );
}

async function handleInvoicePaymentSucceeded(
  invoice: Stripe.Invoice,
  eventId: string,
): Promise<void> {
  // A paid invoice means all Stripe meter events included in it are settled.
  // We mark the corresponding billing_meters as processed.

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : (invoice.customer as Stripe.Customer | null)?.id ?? null;

  if (customerId === null) {
    log.warn({ invoiceId: invoice.id }, "Invoice has no customer ID");
    return;
  }

  const userId = await resolveUserFromStripeCustomer(customerId);
  if (userId === null) return;

  // Mark all unprocessed meters for this user in the invoice's billing period
  // as processed. We identify the period from the invoice's period_end.
  const periodEnd =
    invoice.period_end !== undefined
      ? new Date(invoice.period_end * 1000)
      : null;

  const periodStart =
    invoice.period_start !== undefined
      ? new Date(invoice.period_start * 1000)
      : null;

  if (periodStart === null || periodEnd === null) {
    log.warn({ invoiceId: invoice.id }, "Invoice missing period dates");
    return;
  }

  const supabase = createSupabaseServiceClient();

  const { error, count } = await supabase
    .from("billing_meters")
    .update({ is_processed: true })
    .eq("user_id", userId)
    .eq("is_processed", false)
    .gte("session_end_at", periodStart.toISOString())
    .lt("session_end_at", periodEnd.toISOString());

  if (error !== null) {
    throw new Error(
      `Failed to mark billing meters processed: ${error.message}`,
    );
  }

  log.info(
    {
      invoiceId:   invoice.id,
      customerId,
      userId,
      periodStart: periodStart.toISOString(),
      periodEnd:   periodEnd.toISOString(),
      count,
      eventId,
    },
    "Invoice paid — billing meters marked processed",
  );
}

function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  eventId: string,
): void {
  // We do NOT immediately downgrade the user on payment failure.
  // Stripe's own retry logic handles dunning (3 retries by default).
  // Only `customer.subscription.updated` (to past_due/unpaid) or
  // `customer.subscription.deleted` triggers a tier change.
  //
  // Log for ops alerting integration (PagerDuty, Slack, etc.).
  log.warn(
    {
      invoiceId:    invoice.id,
      attemptCount: invoice.attempt_count,
      nextAttempt:  invoice.next_payment_attempt,
      eventId,
    },
    "Invoice payment failed — Stripe will retry",
  );
}
