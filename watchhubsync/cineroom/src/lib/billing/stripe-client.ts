/**
 * src/lib/billing/stripe-client.ts
 *
 * Stripe SDK Singleton — Server-Side Only.
 *
 * Lazily initialized on first use, verified at initialization time.
 * This module must NEVER be imported in client-side code — the secret key
 * would be leaked to the browser bundle.
 *
 * API version is pinned to match the Stripe SDK version (16.2.0).
 * Upgrading the Stripe SDK requires re-pinning this string and auditing
 * all API calls for breaking changes.
 *
 * Configuration:
 *   STRIPE_SECRET_KEY     — required; sk_live_* in production, sk_test_* in dev
 *   STRIPE_WEBHOOK_SECRET — required; whsec_* from Stripe dashboard
 *   STRIPE_PRICE_ID_PREMIUM — required; Stripe Price ID for the Premium plan
 *   STRIPE_METER_ID_PARTICIPANT_MINUTES — required; Stripe Meter ID for usage
 */

import Stripe from "stripe";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Pinned API version — must match the minimum version required by SDK v16.2.0.
 * See: https://stripe.com/docs/api/versioning
 */
const STRIPE_API_VERSION = "2024-06-20" as const;

/**
 * Maximum network retry attempts for transient Stripe API errors (429, 500, 502).
 * Stripe SDK has built-in exponential backoff for these retries.
 */
const STRIPE_MAX_RETRIES = 3 as const;

/**
 * Connect timeout for Stripe API calls (ms).
 * Long enough for most calls; the webhook handler has a separate timeout.
 */
const STRIPE_TIMEOUT_MS = 10_000 as const;

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------

interface StripeEnv {
  readonly secretKey:                   string;
  readonly webhookSecret:               string;
  readonly pricePremium:                string;
  readonly meterIdParticipantMinutes:   string;
}

function resolveStripeEnv(): StripeEnv {
  const vars = {
    secretKey:                 process.env["STRIPE_SECRET_KEY"],
    webhookSecret:             process.env["STRIPE_WEBHOOK_SECRET"],
    pricePremium:              process.env["STRIPE_PRICE_ID_PREMIUM"],
    meterIdParticipantMinutes: process.env["STRIPE_METER_ID_PARTICIPANT_MINUTES"],
  } as const;

  const missing = Object.entries(vars)
    .filter(([, v]) => v === undefined || v.trim().length === 0)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Stripe client initialization failed. Missing environment variables: ` +
        missing.join(", "),
    );
  }

  return {
    secretKey:                 vars.secretKey!,
    webhookSecret:             vars.webhookSecret!,
    pricePremium:              vars.pricePremium!,
    meterIdParticipantMinutes: vars.meterIdParticipantMinutes!,
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _stripe: Stripe | null = null;
let _stripeEnv: StripeEnv | null = null;

/**
 * Returns the initialized Stripe client singleton.
 * Throws if required environment variables are missing.
 * Safe to call multiple times — initializes only once.
 */
export function getStripeClient(): Stripe {
  if (_stripe !== null) return _stripe;

  const env = resolveStripeEnv();
  _stripeEnv = env;

  _stripe = new Stripe(env.secretKey, {
    apiVersion:  STRIPE_API_VERSION,
    maxNetworkRetries: STRIPE_MAX_RETRIES,
    timeout:     STRIPE_TIMEOUT_MS,
    appInfo: {
      name:    "WatchHubSync",
      version: "1.0.0",
      url:     "https://watchhubsync.com",
    },
  });

  return _stripe;
}

/**
 * Returns resolved Stripe environment config.
 * Triggers singleton initialization if not yet done.
 */
export function getStripeEnv(): StripeEnv {
  if (_stripeEnv !== null) return _stripeEnv;
  getStripeClient(); // triggers initialization and sets _stripeEnv
  return _stripeEnv!;
}

// ---------------------------------------------------------------------------
// Stripe-specific billing helpers
// ---------------------------------------------------------------------------

/**
 * Verify a Stripe webhook signature and construct a typed event.
 *
 * IMPORTANT: `rawBody` must be the raw, unparsed request body as a string.
 * Parsing the body as JSON before calling this function will break HMAC
 * verification because JSON serialization is not round-trip stable.
 *
 * @param rawBody    — `await request.text()` from the route handler
 * @param signature  — `request.headers.get('stripe-signature')`
 * @throws           — If signature is invalid or the event cannot be constructed
 */
export function constructStripeEvent(
  rawBody: string,
  signature: string | null,
): Stripe.Event {
  const stripe = getStripeClient();
  const { webhookSecret } = getStripeEnv();

  if (signature === null || signature.trim().length === 0) {
    throw new Error("Missing stripe-signature header");
  }

  // stripe.webhooks.constructEvent throws on invalid signature — intentional.
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/**
 * Push a batch of participant-minutes usage events to the Stripe Meter.
 *
 * Each call is idempotent via the `identifier` field — if Stripe has already
 * recorded an event with the same identifier, it will return the existing
 * record without creating a duplicate charge.
 *
 * @param events — Array of meter event payloads to push
 */
export async function pushStripeParticipantMinutes(
  events: ReadonlyArray<{
    readonly billingMeterId: string;    // Our DB ID — used as idempotency key
    readonly stripeCustomerId: string;
    readonly participantMinutes: number;
    readonly sessionEndAt: Date;        // Timestamp for Stripe's metering window
  }>,
): Promise<{ readonly pushed: number; readonly skipped: number }> {
  if (events.length === 0) return { pushed: 0, skipped: 0 };

  const stripe = getStripeClient();
  const { meterIdParticipantMinutes } = getStripeEnv();

  let pushed  = 0;
  let skipped = 0;

  // Push in series — Stripe Meter Events API has a rate limit of 1000 req/s.
  // Parallelizing risks 429s; series ensures ordering and simpler retry logic.
  for (const event of events) {
    if (event.participantMinutes <= 0) {
      skipped++;
      continue;
    }

    try {
      await stripe.billing.meterEvents.create({
        event_name: meterIdParticipantMinutes,
        payload: {
          stripe_customer_id: event.stripeCustomerId,
          value: String(event.participantMinutes),
        },
        identifier: event.billingMeterId,
        timestamp:  Math.floor(event.sessionEndAt.getTime() / 1000),
      });
      pushed++;
    } catch (err) {
      // Stripe returns a 400 with code "duplicate" for already-processed events.
      // These are safe to swallow — the event was already counted.
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        (err.code === "duplicate" || err.param === "identifier")
      ) {
        skipped++;
        continue;
      }
      // Re-throw all other errors — the caller handles retry/alerting
      throw err;
    }
  }

  return { pushed, skipped };
}

// ---------------------------------------------------------------------------
// Test helper — reset singleton (never call in production code)
// ---------------------------------------------------------------------------

export function _resetStripeClientForTests(): void {
  if (process.env["NODE_ENV"] !== "test") {
    throw new Error("_resetStripeClientForTests() called outside of test env");
  }
  _stripe    = null;
  _stripeEnv = null;
}
