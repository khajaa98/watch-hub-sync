/**
 * src/lib/billing/razorpay-client.ts
 *
 * Razorpay SDK Singleton — Server-Side Only (India-First Billing).
 *
 * Razorpay is the primary payment processor for Indian users. It handles:
 *   - UPI Autopay subscriptions (recurring monthly billing)
 *   - Net banking and card payments
 *   - Subscription lifecycle events via webhooks
 *
 * Webhook signature verification uses HMAC-SHA256 of the raw request body
 * signed with `RAZORPAY_WEBHOOK_SECRET`. This is implemented as a pure
 * function using Node.js `crypto` so it can be tested without mocking the SDK.
 *
 * Configuration:
 *   RAZORPAY_KEY_ID         — required; rzp_live_* or rzp_test_* key ID
 *   RAZORPAY_KEY_SECRET     — required; paired secret key
 *   RAZORPAY_WEBHOOK_SECRET — required; webhook signing secret from dashboard
 *   RAZORPAY_PLAN_ID_PREMIUM — required; Razorpay Plan ID for the Premium plan
 */

import Razorpay from "razorpay";
import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RazorpayEnv {
  readonly keyId:          string;
  readonly keySecret:      string;
  readonly webhookSecret:  string;
  readonly planIdPremium:  string;
}

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------

function resolveRazorpayEnv(): RazorpayEnv {
  const vars = {
    keyId:         process.env["RAZORPAY_KEY_ID"],
    keySecret:     process.env["RAZORPAY_KEY_SECRET"],
    webhookSecret: process.env["RAZORPAY_WEBHOOK_SECRET"],
    planIdPremium: process.env["RAZORPAY_PLAN_ID_PREMIUM"],
  } as const;

  const missing = Object.entries(vars)
    .filter(([, v]) => v === undefined || v.trim().length === 0)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Razorpay client initialization failed. Missing environment variables: ` +
        missing.join(", "),
    );
  }

  return {
    keyId:         vars.keyId!,
    keySecret:     vars.keySecret!,
    webhookSecret: vars.webhookSecret!,
    planIdPremium: vars.planIdPremium!,
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _razorpay: Razorpay | null = null;
let _razorpayEnv: RazorpayEnv | null = null;

/**
 * Returns the initialized Razorpay client singleton.
 * Throws if required environment variables are missing.
 */
export function getRazorpayClient(): Razorpay {
  if (_razorpay !== null) return _razorpay;

  const env = resolveRazorpayEnv();
  _razorpayEnv = env;

  _razorpay = new Razorpay({
    key_id:     env.keyId,
    key_secret: env.keySecret,
  });

  return _razorpay;
}

export function getRazorpayEnv(): RazorpayEnv {
  if (_razorpayEnv !== null) return _razorpayEnv;
  getRazorpayClient();
  return _razorpayEnv!;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a Razorpay webhook signature.
 *
 * Razorpay signs the raw request body with HMAC-SHA256 using the webhook
 * secret and sends the hex digest in the `x-razorpay-signature` header.
 *
 * Uses `timingSafeEqual` to prevent timing-based signature oracle attacks —
 * a standard vulnerability in naive string comparison implementations.
 *
 * @param rawBody   — `await request.text()` — MUST be called before any JSON parse
 * @param signature — `request.headers.get('x-razorpay-signature')`
 *
 * @returns true if the signature is valid, false otherwise
 *
 * NEVER throw on invalid signatures — always return false and let the
 * route handler return 401. Throwing exposes timing information.
 */
export function verifyRazorpaySignature(
  rawBody: string,
  signature: string | null,
): boolean {
  if (signature === null || signature.trim().length === 0) return false;

  let webhookSecret: string;
  try {
    webhookSecret = getRazorpayEnv().webhookSecret;
  } catch {
    // Environment not configured — fail closed
    return false;
  }

  try {
    const expectedBuffer = createHmac("sha256", webhookSecret)
      .update(rawBody, "utf8")
      .digest();

    const receivedBuffer = Buffer.from(signature, "hex");

    // timingSafeEqual requires equal-length buffers
    if (expectedBuffer.length !== receivedBuffer.length) return false;

    return timingSafeEqual(expectedBuffer, receivedBuffer);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Typed Razorpay webhook payload shapes
//
// Razorpay's npm package does not ship webhook payload types.
// We define the minimum subset needed for our handlers.
// ---------------------------------------------------------------------------

export interface RazorpaySubscriptionEntity {
  readonly id:          string;
  readonly plan_id:     string;
  readonly status:      "created" | "authenticated" | "active" | "pending" | "halted" | "cancelled" | "completed" | "expired";
  readonly quantity:    number;
  readonly notes:       Record<string, string>;
  /** Our internal user_id, stored in subscription notes at creation time. */
  readonly customer_id: string;
  readonly current_start:  number; // Unix epoch seconds
  readonly current_end:    number; // Unix epoch seconds
  readonly charge_at:      number; // Unix epoch seconds
  readonly paid_count:     number;
  readonly total_count:    number;
}

export interface RazorpayPaymentEntity {
  readonly id:              string;
  readonly amount:          number; // paise (1 INR = 100 paise)
  readonly currency:        string;
  readonly status:          "created" | "authorized" | "captured" | "refunded" | "failed";
  readonly subscription_id: string | undefined;
  readonly invoice_id:      string | undefined;
  readonly captured:        boolean;
}

export interface RazorpayWebhookPayload<T = unknown> {
  readonly entity:    "event";
  readonly account_id: string;
  readonly event:     string;  // e.g. "subscription.charged"
  readonly contains:  readonly string[];
  readonly payload: {
    readonly subscription?: { readonly entity: RazorpaySubscriptionEntity };
    readonly payment?:      { readonly entity: RazorpayPaymentEntity };
  };
  readonly created_at: number; // Unix epoch seconds
}

export type RazorpaySubscriptionChargedPayload =
  RazorpayWebhookPayload<{
    subscription: RazorpaySubscriptionEntity;
    payment:      RazorpayPaymentEntity;
  }>;

export type RazorpaySubscriptionHaltedPayload =
  RazorpayWebhookPayload<{
    subscription: RazorpaySubscriptionEntity;
  }>;

// ---------------------------------------------------------------------------
// Razorpay notes convention
// ---------------------------------------------------------------------------

/**
 * Keys used in Razorpay subscription notes to link back to our user model.
 * These are set when creating the subscription via POST /api/billing/subscribe.
 */
export const RAZORPAY_NOTES_KEYS = {
  USER_ID:        "whs_user_id",
  SUPABASE_EMAIL: "whs_email",
} as const;

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

export function _resetRazorpayClientForTests(): void {
  if (process.env["NODE_ENV"] !== "test") {
    throw new Error("_resetRazorpayClientForTests() called outside of test env");
  }
  _razorpay    = null;
  _razorpayEnv = null;
}
