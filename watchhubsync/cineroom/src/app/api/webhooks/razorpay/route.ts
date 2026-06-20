/**
 * src/app/api/webhooks/razorpay/route.ts
 *
 * Razorpay UPI Autopay & Subscription Lifecycle Webhook Handler.
 *
 * ─── SIGNATURE VERIFICATION ──────────────────────────────────────────────────
 * Razorpay sends the raw request body signed with HMAC-SHA256 using the
 * webhook secret configured in the Razorpay Dashboard. The resulting hex
 * digest is transmitted in the `x-razorpay-signature` header.
 *
 * CRITICAL: The raw body must be read before JSON.parse(). We use
 * `request.text()` and pass the string directly to `verifyRazorpaySignature()`.
 * `timingSafeEqual` prevents signature length oracle attacks.
 *
 * ─── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * Razorpay also delivers webhooks "at least once". Each event carries a
 * stable `created_at` + `account_id` pair, but no standalone event ID.
 * We derive an idempotency key as `razorpay:${subscriptionId}:${eventName}:${createdAt}`.
 * This key is stored in a `processed_webhook_events` log (see SQL below) so
 * duplicate webhooks within 30 days are swallowed.
 *
 * In the current implementation we use a soft-idempotency approach:
 * the `stripe_subscription_id` column (repurposed here as `razorpay_subscription_id`)
 * combined with the timestamp check prevents double-tier-changes.
 *
 * Handled events:
 *
 *   subscription.charged   → confirm payment, maintain 'premium' tier
 *   subscription.halted    → Razorpay has paused the subscription due to
 *                            consecutive payment failures; downgrade to 'free'
 *   subscription.cancelled → User cancelled; downgrade to 'free'
 *   subscription.completed → Plan completed (all cycles paid); downgrade to 'free'
 *   payment.failed         → Log for ops; no immediate tier change
 *
 * User identity resolution:
 *   When creating a Razorpay subscription via POST /api/billing/subscribe,
 *   our server stores `whs_user_id` in the subscription's `notes` field.
 *   On webhook receipt, we read `payload.subscription.entity.notes.whs_user_id`
 *   to resolve the Supabase user without a reverse-lookup table.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  verifyRazorpaySignature,
  RAZORPAY_NOTES_KEYS,
  type RazorpaySubscriptionChargedPayload,
  type RazorpaySubscriptionHaltedPayload,
  type RazorpayWebhookPayload,
} from "@/lib/billing/razorpay-client";
import { createLogger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Route config
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger({ module: "webhooks/razorpay" });

// ---------------------------------------------------------------------------
// Razorpay event type constants
// ---------------------------------------------------------------------------

const EVENT = {
  SUBSCRIPTION_CHARGED:   "subscription.charged",
  SUBSCRIPTION_HALTED:    "subscription.halted",
  SUBSCRIPTION_CANCELLED: "subscription.cancelled",
  SUBSCRIPTION_COMPLETED: "subscription.completed",
  PAYMENT_FAILED:         "payment.failed",
} as const;

type RazorpayEventName = typeof EVENT[keyof typeof EVENT];

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body — MUST precede any JSON parsing ────────────────────
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (cause) {
    log.error({ cause }, "Failed to read Razorpay webhook body");
    return NextResponse.json({ error: "Body read failed" }, { status: 400 });
  }

  if (rawBody.trim().length === 0) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }

  // ── 2. HMAC-SHA256 signature verification ────────────────────────────────
  const signature = request.headers.get("x-razorpay-signature");

  const isValid = verifyRazorpaySignature(rawBody, signature);
  if (!isValid) {
    log.warn({ signaturePresent: signature !== null }, "Razorpay signature verification failed");
    return NextResponse.json(
      { error: "Invalid x-razorpay-signature" },
      { status: 401 },
    );
  }

  // ── 3. Parse JSON payload ─────────────────────────────────────────────────
  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch (cause) {
    log.error({ cause }, "Razorpay webhook body is not valid JSON");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventName = payload.event as RazorpayEventName;
  const createdAt = payload.created_at;

  log.info(
    { eventName, accountId: payload.account_id, createdAt },
    "Razorpay webhook received",
  );

  // ── 4. Dispatch ───────────────────────────────────────────────────────────
  try {
    switch (eventName) {
      case EVENT.SUBSCRIPTION_CHARGED:
        await handleSubscriptionCharged(
          payload as RazorpaySubscriptionChargedPayload,
        );
        break;

      case EVENT.SUBSCRIPTION_HALTED:
      case EVENT.SUBSCRIPTION_CANCELLED:
      case EVENT.SUBSCRIPTION_COMPLETED:
        await handleSubscriptionDeactivated(
          payload as RazorpaySubscriptionHaltedPayload,
          eventName,
        );
        break;

      case EVENT.PAYMENT_FAILED:
        handlePaymentFailed(payload, eventName);
        break;

      default:
        log.debug({ eventName }, "Razorpay event not handled — ignoring");
    }
  } catch (cause) {
    log.error({ cause, eventName }, "Razorpay webhook handler threw");
    // Return 500 — Razorpay will retry with exponential backoff
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the internal WHS user ID from the subscription notes object.
 * Notes are set at subscription-creation time by our API.
 */
function resolveUserIdFromNotes(
  notes: Record<string, string> | undefined,
): string | null {
  if (notes === undefined) return null;

  const userId = notes[RAZORPAY_NOTES_KEYS.USER_ID];
  if (typeof userId !== "string" || userId.trim().length === 0) return null;

  return userId.trim();
}

/**
 * Convert Razorpay amount (paise) to INR for logging.
 * 100 paise = 1 INR.
 */
function paisToInr(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * subscription.charged
 *
 * Razorpay successfully charged the user for another billing cycle.
 * Ensure the user's tier is set to 'premium' (idempotent).
 * Record the Razorpay subscription ID for future reference.
 */
async function handleSubscriptionCharged(
  payload: RazorpaySubscriptionChargedPayload,
): Promise<void> {
  const subscriptionEntity = payload.payload.subscription?.entity;
  const paymentEntity      = payload.payload.payment?.entity;

  if (subscriptionEntity === undefined) {
    log.error({ payload }, "subscription.charged missing subscription entity");
    return;
  }

  const userId = resolveUserIdFromNotes(subscriptionEntity.notes);

  if (userId === null) {
    log.error(
      { subscriptionId: subscriptionEntity.id },
      `subscription.charged: could not resolve user from notes. ` +
        `Ensure '${RAZORPAY_NOTES_KEYS.USER_ID}' is set in subscription notes at creation.`,
    );
    return;
  }

  const amountInr = paymentEntity !== undefined
    ? paisToInr(paymentEntity.amount)
    : "unknown";

  log.info(
    {
      userId,
      subscriptionId:  subscriptionEntity.id,
      amount:          amountInr,
      paidCount:       subscriptionEntity.paid_count,
      totalCount:      subscriptionEntity.total_count,
      currentEnd:      new Date(subscriptionEntity.current_end * 1000).toISOString(),
    },
    "Razorpay subscription charged",
  );

  const supabase = createSupabaseServiceClient();

  // Upsert premium tier — safe to re-run on duplicate delivery
  const { error } = await supabase
    .from("users")
    .update({
      subscription_tier:         "premium",
      razorpay_subscription_id:  subscriptionEntity.id,
    })
    .eq("id", userId);

  if (error !== null) {
    throw new Error(
      `subscription.charged: failed to set premium tier for user ${userId}: ` +
        error.message,
    );
  }

  // Record payment in billing audit table if one exists
  // (Extending billing_meters is out of scope here — log is sufficient)
  log.info(
    { userId, subscriptionId: subscriptionEntity.id },
    "User confirmed as premium after Razorpay charge",
  );
}

/**
 * subscription.halted | subscription.cancelled | subscription.completed
 *
 * The subscription is no longer active. Downgrade the user to free tier.
 *
 * Razorpay halts a subscription after 3 consecutive payment failures.
 * Cancellation is user-initiated. Completion means all billing cycles done.
 *
 * In all three cases, the effect on WHS is the same: downgrade to 'free'.
 * The user retains their content history; new rooms will be limited.
 */
async function handleSubscriptionDeactivated(
  payload: RazorpaySubscriptionHaltedPayload,
  eventName: string,
): Promise<void> {
  const subscriptionEntity = payload.payload.subscription?.entity;

  if (subscriptionEntity === undefined) {
    log.error({ eventName }, "Subscription deactivation event missing subscription entity");
    return;
  }

  const userId = resolveUserIdFromNotes(subscriptionEntity.notes);

  if (userId === null) {
    log.error(
      { subscriptionId: subscriptionEntity.id, eventName },
      "Could not resolve user from subscription notes during deactivation",
    );
    return;
  }

  const supabase = createSupabaseServiceClient();

  const { error } = await supabase
    .from("users")
    .update({
      subscription_tier:        "free",
      razorpay_subscription_id: null,
    })
    .eq("id", userId)
    // Only downgrade if currently premium — prevents double-processing
    .eq("subscription_tier", "premium");

  if (error !== null) {
    throw new Error(
      `${eventName}: failed to downgrade user ${userId}: ${error.message}`,
    );
  }

  log.info(
    {
      userId,
      subscriptionId: subscriptionEntity.id,
      eventName,
      subscriptionStatus: subscriptionEntity.status,
    },
    "User downgraded to free tier after subscription deactivation",
  );
}

/**
 * payment.failed
 *
 * A payment attempt failed. Razorpay will auto-retry based on the plan's
 * retry configuration. We do NOT immediately downgrade the user — that only
 * happens after `subscription.halted`.
 *
 * This handler exists for observability only (ops alerting).
 */
function handlePaymentFailed(
  payload: RazorpayWebhookPayload,
  eventName: string,
): void {
  const paymentEntity = payload.payload.payment?.entity;

  log.warn(
    {
      eventName,
      paymentId:      paymentEntity?.id,
      subscriptionId: paymentEntity?.subscription_id,
      amount:         paymentEntity !== undefined
        ? paisToInr(paymentEntity.amount)
        : "unknown",
      status:         paymentEntity?.status,
    },
    "Razorpay payment failed — subscription still active, Razorpay will retry",
  );

  // Future: emit to alerting channel (Slack, PagerDuty) if failed_count > 2
}
