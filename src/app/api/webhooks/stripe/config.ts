/**
 * src/app/api/webhooks/stripe/config.ts
 *
 * Stripe Webhook — Centralised Configuration & Metadata Map.
 *
 * This module is the single source of truth for all Stripe-related
 * constants used across the webhook handler (`route.ts`), the billing
 * client (`lib/billing/stripe-client.ts`), and the meter calculator
 * (`lib/billing/meter-calculator.ts`).
 *
 * ─── WHAT LIVES HERE ──────────────────────────────────────────────────────────
 *
 *   1. Stripe API version pin          — enforced on every SDK initialisation
 *   2. Handled event type registry     — typed union + O(1) Set for dispatch
 *   3. Meter event field schema        — maps meter-calculator output → Stripe API
 *   4. UK entity configuration         — settlement currency, country, tax behaviour
 *   5. Idempotency key construction    — deterministic key format for meter events
 *   6. Webhook security constants      — signature header name, body constraints
 *
 * ─── WHAT DOES NOT LIVE HERE ─────────────────────────────────────────────────
 *
 *   • Stripe secret keys        — read from `serverEnv.STRIPE_SECRET_KEY`
 *   • Webhook signing secrets   — read from `serverEnv.STRIPE_WEBHOOK_SECRET`
 *   • Price IDs, meter IDs      — read from `serverEnv.STRIPE_PRICE_ID_PREMIUM`
 *                                  and `serverEnv.STRIPE_METER_ID_PARTICIPANT_MINUTES`
 *
 * All secrets flow through the Zod-validated `serverEnv` singleton
 * in `src/lib/env.ts`, which exits the process at build time if any
 * required variable is absent or malformed.
 *
 * ─── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   import {
 *     STRIPE_API_VERSION,
 *     isHandledStripeEvent,
 *     METER_EVENT_CONFIG,
 *     UK_ENTITY_CONFIG,
 *   } from "@/app/api/webhooks/stripe/config";
 */

import type Stripe from "stripe";
import { serverEnv } from "@/lib/env";

// ---------------------------------------------------------------------------
// 1. Stripe API Version Pin
// ---------------------------------------------------------------------------

/**
 * Pinned Stripe API version.
 *
 * NEVER upgrade this without:
 *   a) Reading the Stripe API changelog for breaking changes
 *   b) Testing all webhook event shapes in test mode
 *   c) Verifying `invoice.payment_succeeded` still carries `period_start`/`period_end`
 *   d) Verifying meter event payload shape is unchanged
 *
 * This value is passed to the Stripe SDK constructor in `lib/billing/stripe-client.ts`.
 * It is also embedded in the `Stripe-Version` header on all API calls, ensuring
 * the response shape matches our TypeScript types even if Stripe releases
 * a newer default version.
 */
export const STRIPE_API_VERSION = "2024-06-20" as const;
export type StripeApiVersion = typeof STRIPE_API_VERSION;

// ---------------------------------------------------------------------------
// 2. Handled Event Type Registry
// ---------------------------------------------------------------------------

/**
 * The exhaustive set of Stripe event types this webhook endpoint handles.
 *
 * To add a new event:
 *   1. Add it to `HANDLED_STRIPE_EVENTS` array below
 *   2. Add a case to the switch in `route.ts`
 *   3. Implement the handler function
 *   4. Register the event in the Stripe Dashboard webhook configuration
 *      (see STRIPE_SETUP.md §6.2)
 *
 * Events NOT in this list return 200 immediately (ignored but acknowledged).
 * Never return 4xx/5xx for unknown events — Stripe would pause delivery.
 */
const HANDLED_STRIPE_EVENTS = [
  // ── Subscription lifecycle ────────────────────────────────────────────────
  "customer.subscription.created",    // → Upgrade user to 'premium'
  "customer.subscription.updated",    // → Sync status (active / past_due / etc.)
  "customer.subscription.deleted",    // → Downgrade user to 'free'

  // ── Invoice / payment ─────────────────────────────────────────────────────
  "invoice.payment_succeeded",        // → Mark billing_meters.is_processed = true
  "invoice.payment_failed",           // → Log for ops alerting; no immediate downgrade

  // ── Meter events (future) ─────────────────────────────────────────────────
  // "billing.meter_event_adjustment",  // Uncomment when credit handling is implemented
] as const;

/** Typed union of all handled Stripe event type strings. */
export type HandledStripeEventType = (typeof HANDLED_STRIPE_EVENTS)[number];

/**
 * O(1) lookup Set — use `isHandledStripeEvent()` in route.ts instead of
 * a long `if` chain or array `.includes()` call.
 *
 * @internal
 */
const _handledEventSet = new Set<string>(HANDLED_STRIPE_EVENTS);

/**
 * Type guard: returns true if `eventType` is a Stripe event we handle.
 * Narrows the type to `HandledStripeEventType` in the true branch.
 *
 * @example
 * ```ts
 * if (isHandledStripeEvent(stripeEvent.type)) {
 *   // stripeEvent.type is now HandledStripeEventType
 * }
 * ```
 */
export function isHandledStripeEvent(
  eventType: string,
): eventType is HandledStripeEventType {
  return _handledEventSet.has(eventType);
}

// ---------------------------------------------------------------------------
// 3. Meter Event Field Schema
// ---------------------------------------------------------------------------

/**
 * Canonical mapping between our internal billing domain and Stripe's
 * Meter Events API field names.
 *
 * This is the single authoritative translation layer. Both the server-side
 * billing push in `lib/billing/stripe-client.ts` and any future client-side
 * preview code MUST use these constants rather than string literals.
 *
 * ─── Field resolution chain ───────────────────────────────────────────────
 *
 *   LiveKit `participant_left` webhook
 *     → `lib/billing/meter-calculator.ts` (calculateBillableMinutes)
 *       → `chargeable_minutes` (integer)
 *         → METER_EVENT_CONFIG.valueField = "value"  (Stripe payload field name)
 *           → Stripe Meter Event API
 *             → Stripe invoice line item
 *               → invoice.payment_succeeded webhook
 *                 → billing_meters.is_processed = true
 */
export const METER_EVENT_CONFIG = {
  /**
   * The event name registered in the Stripe Billing Meter.
   * Must exactly match the `Event name` field set in Stripe Dashboard
   * → Billing → Meters → participant_minutes
   * (see STRIPE_SETUP.md §5.1).
   */
  eventName: "participant_minutes" as const,

  /**
   * The payload field Stripe reads as the numeric quantity for this event.
   * Stripe expects this as a string-cast number (e.g., "42", not 42).
   * Set in Stripe Meter configuration as "Value settings → Value field".
   */
  valueField: "value" as const,

  /**
   * The payload field Stripe uses to map this event to a customer.
   * Set in Stripe Meter configuration as "Customer mapping → Field".
   * The value must be a Stripe customer ID (`cus_...`).
   */
  customerField: "stripe_customer_id" as const,

  /**
   * How the meter aggregates multiple events in a billing period.
   * "sum" means Stripe adds all `value` quantities together for the period.
   * Must match the "Default aggregation" setting in the Stripe Meter config.
   */
  aggregation: "sum" as const,
} as const;

export type MeterEventConfig = typeof METER_EVENT_CONFIG;

/**
 * The exact payload shape pushed to Stripe's Meter Events API.
 * Used in `lib/billing/stripe-client.ts` → `pushStripeParticipantMinutes()`.
 *
 * Stripe reference:
 *   POST /v1/billing/meter_events
 *   https://stripe.com/docs/api/billing/meter-event/create
 */
export interface StripeMeterEventPayload {
  /** Stripe Meter event name — matches `METER_EVENT_CONFIG.eventName`. */
  readonly event_name: typeof METER_EVENT_CONFIG.eventName;

  /** Key-value payload delivered to Stripe Meter. */
  readonly payload: {
    /** Stripe customer ID (`cus_...`) — identifies whose usage this is. */
    readonly [K in typeof METER_EVENT_CONFIG.customerField]: string;
  } & {
    /**
     * Chargeable minutes as a string-cast integer.
     * Source: `meter-calculator.ts` → `calculateBillableMinutes()` → `chargeableMinutes`.
     * The free-tier cap (120 min/month) is applied BEFORE this value is computed.
     * Minimum value: "1" (from the 1-minute billing floor in meter-calculator.ts).
     */
    readonly [K in typeof METER_EVENT_CONFIG.valueField]: string;
  };

  /**
   * Idempotency identifier — Stripe deduplicates meter events by this value
   * within a 24-hour window.
   *
   * Our convention: `livekit_event_id` from the `billing_meters` row.
   * Format enforced by `buildMeterEventIdentifier()` below.
   */
  readonly identifier: string;

  /**
   * Unix timestamp (seconds) of when the session ended.
   * Stripe uses this to assign the event to the correct billing period.
   * Source: `billing_meters.session_end_at` converted to epoch seconds.
   */
  readonly timestamp: number;
}

/**
 * Build the canonical idempotency identifier for a meter event.
 *
 * Format: `whs_<livekitEventId>`
 *
 * The `whs_` prefix namespaces our identifiers from other systems sharing
 * the same Stripe account. The LiveKit event ID is the stable, server-assigned
 * UUID from the LiveKit webhook payload — it never changes on retry.
 *
 * This is also stored as `billing_meters.livekit_event_id` (UNIQUE constraint),
 * giving us a two-layer idempotency guarantee:
 *   Layer 1: PostgreSQL UNIQUE constraint prevents duplicate DB rows
 *   Layer 2: Stripe deduplicates by `identifier` within 24 hours
 */
export function buildMeterEventIdentifier(livekitEventId: string): string {
  return `whs_${livekitEventId}`;
}

// ---------------------------------------------------------------------------
// 4. UK Entity Configuration
// ---------------------------------------------------------------------------

/**
 * Letora Ltd — Stripe UK entity configuration.
 *
 * These constants express business decisions that must remain consistent
 * across billing, invoicing, and analytics code:
 *   - GBP as the settlement currency
 *   - UK as the tax jurisdiction
 *   - Metered (usage-based) as the billing model
 *
 * They do NOT contain any secrets, account numbers, or identifiers —
 * those are in Vercel environment variables.
 */
export const UK_ENTITY_CONFIG = {
  /**
   * Settlement currency for all Stripe transactions.
   * Subscriptions are invoiced in GBP.
   * International customers pay in GBP; Stripe handles FX conversion on
   * their card statement.
   */
  currency: "gbp" as const,

  /**
   * Stripe account country — used when creating Payment Intents and
   * for tax jurisdiction resolution via Stripe Tax.
   */
  country: "GB" as const,

  /**
   * Tax behaviour for prices in the product catalogue.
   * "exclusive" = price displayed excludes tax; VAT is added on top at checkout.
   * Required by UK invoicing regulations for B2C SaaS.
   * Switch to "inclusive" only if you move to tax-inclusive pricing.
   */
  taxBehavior: "exclusive" as const,

  /**
   * Stripe Tax product tax code for digital SaaS services sold to UK consumers.
   * Reference: https://stripe.com/docs/tax/tax-codes
   */
  taxCode: "txcd_10103001" as const,

  /**
   * The billing model — usage-based metering.
   * Charges are calculated from Stripe Meter Events, not flat fees.
   */
  billingModel: "usage_based" as const,
} as const;

export type UKEntityConfig = typeof UK_ENTITY_CONFIG;

// ---------------------------------------------------------------------------
// 5. Webhook Security Constants
// ---------------------------------------------------------------------------

/**
 * Stripe's signature header name.
 * Read from the incoming HTTP request before calling `constructStripeEvent()`.
 *
 * Stripe docs: https://stripe.com/docs/webhooks/signatures
 */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature" as const;

/**
 * Clock tolerance for Stripe webhook timestamp verification (seconds).
 *
 * Stripe embeds a `t=` timestamp in the `stripe-signature` header. The SDK
 * rejects events where `|now - t| > tolerance` to prevent replay attacks.
 *
 * 300 seconds (5 minutes) is Stripe's recommended default. Do not increase
 * this without understanding the replay attack surface.
 */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300 as const;

/**
 * Webhook configuration object consumed by `constructStripeEvent()`.
 * Reads secrets at call-time from the Zod-validated `serverEnv` singleton.
 *
 * @example
 * ```ts
 * import { getWebhookConfig } from "@/app/api/webhooks/stripe/config";
 *
 * const { webhookSecret, toleranceSeconds } = getWebhookConfig();
 * stripe.webhooks.constructEvent(rawBody, sig, webhookSecret, toleranceSeconds);
 * ```
 */
export function getWebhookConfig(): {
  readonly webhookSecret:      string;
  readonly toleranceSeconds:   number;
  readonly signatureHeader:    typeof STRIPE_SIGNATURE_HEADER;
} {
  return {
    webhookSecret:    serverEnv.STRIPE_WEBHOOK_SECRET,
    toleranceSeconds: STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    signatureHeader:  STRIPE_SIGNATURE_HEADER,
  };
}

// ---------------------------------------------------------------------------
// 6. Handler Registry Type
// ---------------------------------------------------------------------------

/**
 * Type signature for every Stripe event handler function in `route.ts`.
 * All handlers are async, receive the typed Stripe data object and the
 * event ID, and return void (errors are thrown and caught in the dispatcher).
 */
export type StripeEventHandler<T> = (
  data:    T,
  eventId: string,
) => Promise<void>;

/**
 * Registry mapping each handled event type to its Stripe data object type.
 * Use this as the authoritative type reference when adding new event handlers.
 *
 * The dispatcher in `route.ts` casts `stripeEvent.data.object` to the type
 * listed here before passing it to the corresponding handler.
 *
 * @example Adding a new event:
 * ```ts
 * // 1. Add to HandledStripeEventTypeMap:
 * "billing.meter_event_adjustment": Stripe.Billing.MeterEventAdjustment
 *
 * // 2. Add to HANDLED_STRIPE_EVENTS array above
 *
 * // 3. Add case to route.ts switch statement
 *
 * // 4. Register in Stripe Dashboard webhook config
 * ```
 */
export interface HandledStripeEventTypeMap {
  "customer.subscription.created":  Stripe.Subscription;
  "customer.subscription.updated":  Stripe.Subscription;
  "customer.subscription.deleted":  Stripe.Subscription;
  "invoice.payment_succeeded":      Stripe.Invoice;
  "invoice.payment_failed":         Stripe.Invoice;
}

// ---------------------------------------------------------------------------
// 7. Subscription Status → Tier Mapping
// ---------------------------------------------------------------------------

/**
 * Maps Stripe subscription statuses to our internal subscription tier.
 *
 * Stripe subscription status reference:
 *   https://stripe.com/docs/api/subscriptions/object#subscription_object-status
 *
 * Only `active` and `trialing` grant premium access.
 * `past_due` retains access during the dunning window (Stripe retries 3×).
 * `unpaid` and `canceled` revoke access.
 * `incomplete` / `incomplete_expired` are pre-activation states — no tier change.
 */
export const STRIPE_STATUS_TO_TIER: Readonly<
  Record<Stripe.Subscription.Status, "premium" | "free" | "pending">
> = {
  active:               "premium",
  trialing:             "premium",
  past_due:             "premium",  // Grace period — do not revoke during retry window
  unpaid:               "free",
  canceled:             "free",
  incomplete:           "pending",  // Payment not yet confirmed — no change
  incomplete_expired:   "free",
  paused:               "free",
} as const;

/**
 * Resolve the internal tier from a Stripe subscription status.
 * Returns "pending" for states that should not trigger a tier change.
 */
export function tierFromStripeStatus(
  status: Stripe.Subscription.Status,
): "premium" | "free" | "pending" {
  return STRIPE_STATUS_TO_TIER[status] ?? "free";
}

// ---------------------------------------------------------------------------
// 8. Runtime config validation
// ---------------------------------------------------------------------------

/**
 * Validates at module load time that all Stripe env vars required by this
 * webhook handler are present. Throws immediately if called in a context
 * where `serverEnv` validation was skipped (should never happen in production
 * since next.config.mjs imports env.ts at build time).
 *
 * Call this at the top of the route handler as a belt-and-suspenders check:
 *
 * ```ts
 * // In route.ts:
 * import { assertStripeConfigPresent } from "./config";
 * assertStripeConfigPresent(); // throws if env vars missing
 * ```
 */
export function assertStripeConfigPresent(): void {
  const missing: string[] = [];

  if (
    typeof serverEnv.STRIPE_SECRET_KEY !== "string" ||
    serverEnv.STRIPE_SECRET_KEY.trim().length === 0
  ) {
    missing.push("STRIPE_SECRET_KEY");
  }

  if (
    typeof serverEnv.STRIPE_WEBHOOK_SECRET !== "string" ||
    serverEnv.STRIPE_WEBHOOK_SECRET.trim().length === 0
  ) {
    missing.push("STRIPE_WEBHOOK_SECRET");
  }

  if (
    typeof serverEnv.STRIPE_METER_ID_PARTICIPANT_MINUTES !== "string" ||
    serverEnv.STRIPE_METER_ID_PARTICIPANT_MINUTES.trim().length === 0
  ) {
    missing.push("STRIPE_METER_ID_PARTICIPANT_MINUTES");
  }

  if (missing.length > 0) {
    throw new Error(
      `[stripe/config] Missing required env vars: ${missing.join(", ")}. ` +
        `Set them in Vercel Dashboard → Environment Variables. ` +
        `See STRIPE_SETUP.md §9 for the complete reference.`,
    );
  }
}
