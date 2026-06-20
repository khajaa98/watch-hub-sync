/**
 * src/lib/billing/meter-calculator.ts
 *
 * Pure Billing Metering Core — Zero Network I/O.
 *
 * This module contains ONLY deterministic, side-effect-free math. It has no
 * imports from Supabase, Stripe, Razorpay, or any network library. This
 * isolation is deliberate: the entire module is independently unit-testable
 * without mocking any infrastructure.
 *
 * Temporal contract:
 *
 *   All timestamps are treated as UTC. ISO-8601 strings without a timezone
 *   designator are rejected — never silently assumed to be local time.
 *
 *   Billing unit: 1 billable minute = any started minute of participation.
 *   A session of 61 seconds = 2 billable minutes (ceiling division).
 *   A session of 0–59 seconds = 1 billable minute (minimum floor of 1).
 *
 *   Minimum billable session: 1 minute.
 *   This prevents free-tier abuse via rapid join/leave cycling.
 *
 * Free tier caps (enforced here so the webhook handler stays thin):
 *
 *   FREE_TIER_MONTHLY_MINUTES = 120  (2 hours per calendar month)
 *
 *   `calculateBillableMinutes()` returns the raw session minutes.
 *   `applyTierPolicy()` applies the cap against already-consumed minutes
 *   and returns { billable, overage, cappedAt }.
 *
 * Defensive guarantees:
 *
 *   - Negative durations (clock skew, re-ordered webhooks) → 0
 *   - Invalid/non-parseable timestamps → Result.err with structured error
 *   - Duration overflow guard: sessions > 24h are capped and flagged
 *   - All arithmetic uses integer seconds before dividing, never floats
 *
 * Exported surface:
 *
 *   calculateBillableMinutes(params)  → BillableMinutesResult
 *   applyTierPolicy(params)           → TierPolicyResult
 *   parseSafeTimestamp(value)         → TimestampResult
 *   formatBillingPeriod(date)         → "YYYY-MM" string
 *   BILLING_CONSTANTS                 → readonly config object
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BILLING_CONSTANTS = {
  /**
   * Free-tier monthly cap in minutes.
   * Users exceeding this in a calendar month are charged for overage.
   */
  FREE_TIER_MONTHLY_MINUTES: 120,

  /**
   * Maximum session duration we will record without flagging as anomalous.
   * Sessions longer than this are capped and the overage is flagged for
   * manual review (likely a dangling participant from a missed webhook).
   */
  MAX_SESSION_DURATION_HOURS: 24,

  /**
   * Minimum billable session regardless of actual duration.
   * Prevents microcharge gaming and covers WebSocket handshake overhead.
   */
  MIN_BILLABLE_MINUTES: 1,
} as const;

const MAX_SESSION_SECONDS =
  BILLING_CONSTANTS.MAX_SESSION_DURATION_HOURS * 60 * 60;

// ---------------------------------------------------------------------------
// Result type — explicit error handling, no throw-based control flow
// ---------------------------------------------------------------------------

export type Result<T, E = BillingCalculationError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err<T>(error: BillingCalculationError): Result<T> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type BillingErrorCode =
  | "INVALID_TIMESTAMP"         // Could not parse the timestamp string
  | "MISSING_TIMEZONE"          // ISO string lacked timezone designator
  | "NEGATIVE_DURATION"         // end < start (clock skew / event re-ordering)
  | "ZERO_DURATION"             // Identical start and end
  | "ANOMALOUS_DURATION"        // Duration exceeded MAX_SESSION_DURATION_HOURS
  | "INVALID_INPUT";            // Null, undefined, or wrong type

export interface BillingCalculationError {
  readonly code: BillingErrorCode;
  readonly message: string;
  readonly input?: unknown;
}

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

export interface ParsedTimestamp {
  /** Milliseconds since Unix epoch (UTC). */
  readonly epochMs: number;
  /** Original input for audit logging. */
  readonly raw: string;
}

export type TimestampResult = Result<ParsedTimestamp>;

/**
 * Parse a timestamp string to UTC milliseconds safely.
 *
 * Accepts:
 *   - ISO-8601 with UTC designator:  "2024-08-15T12:30:00.000Z"
 *   - ISO-8601 with offset:          "2024-08-15T18:00:00+05:30"
 *   - RFC 2822:                      "Thu, 15 Aug 2024 12:30:00 +0000"
 *   - Unix epoch seconds (number):   1723724400
 *   - Unix epoch ms (number):        1723724400000
 *
 * Rejects:
 *   - ISO strings without timezone:  "2024-08-15T12:30:00" (ambiguous)
 *   - NaN-producing inputs
 *   - Non-string, non-number types
 */
export function parseSafeTimestamp(
  value: unknown,
): TimestampResult {
  if (value === null || value === undefined) {
    return err({
      code: "INVALID_INPUT",
      message: "Timestamp value is null or undefined",
      input: value,
    });
  }

  // Numeric input — treat as Unix epoch.
  // If value < 1e10 it's in seconds; otherwise milliseconds.
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      return err({
        code: "INVALID_TIMESTAMP",
        message: "Numeric timestamp is NaN or Infinity",
        input: value,
      });
    }

    const epochMs = value < 1e10 ? value * 1000 : value;
    return ok({ epochMs, raw: String(value) });
  }

  // BigInt from protobuf (LiveKit participant.joinedAt)
  if (typeof value === "bigint") {
    // LiveKit sends joinedAt as Unix seconds in bigint
    const epochMs = Number(value) * 1000;
    return ok({ epochMs, raw: String(value) });
  }

  if (typeof value !== "string") {
    return err({
      code: "INVALID_INPUT",
      message: `Expected string or number, received ${typeof value}`,
      input: value,
    });
  }

  const raw = value.trim();

  if (raw.length === 0) {
    return err({
      code: "INVALID_INPUT",
      message: "Timestamp string is empty",
      input: raw,
    });
  }

  // Reject ISO strings without timezone designator.
  // "2024-08-15T12:30:00" is ambiguous — we never assume local time.
  const isIsoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw);
  if (isIsoLike) {
    const hasTimezone =
      raw.endsWith("Z") ||
      /[+-]\d{2}:\d{2}$/.test(raw) ||
      /[+-]\d{4}$/.test(raw);

    if (!hasTimezone) {
      return err({
        code: "MISSING_TIMEZONE",
        message:
          "ISO-8601 timestamp must include a timezone designator (Z or +HH:MM). " +
          "Naive local-time strings are rejected to prevent billing errors.",
        input: raw,
      });
    }
  }

  const parsed = Date.parse(raw);

  if (Number.isNaN(parsed)) {
    return err({
      code: "INVALID_TIMESTAMP",
      message: `Could not parse timestamp: "${raw}"`,
      input: raw,
    });
  }

  return ok({ epochMs: parsed, raw });
}

// ---------------------------------------------------------------------------
// Core calculation
// ---------------------------------------------------------------------------

export interface BillableMinutesParams {
  /** Session start — ISO-8601 UTC string, Unix epoch number, or BigInt seconds. */
  readonly joinedAt: unknown;
  /** Session end — ISO-8601 UTC string, Unix epoch number, or BigInt seconds. */
  readonly leftAt: unknown;
}

export interface BillableMinutesValue {
  /** Whole minutes to bill (ceiling division, minimum 1). */
  readonly billableMinutes: number;
  /** Raw session duration in integer seconds. */
  readonly durationSeconds: number;
  /** True when session exceeded MAX_SESSION_DURATION_HOURS — flag for review. */
  readonly isAnomalous: boolean;
  /** Capped duration used for billing (equals durationSeconds unless anomalous). */
  readonly cappedDurationSeconds: number;
  /** Parsed start for audit insertion. */
  readonly sessionStartAt: Date;
  /** Parsed end for audit insertion. */
  readonly sessionEndAt: Date;
}

export type BillableMinutesResult = Result<BillableMinutesValue>;

/**
 * Calculate billable minutes for a single participant session.
 *
 * @param params.joinedAt — Participant join timestamp
 * @param params.leftAt   — Participant leave timestamp
 *
 * @returns BillableMinutesResult — ok with value, or err with structured error
 *
 * Billing rules:
 *   - Duration is computed in whole seconds: floor(leftAt - joinedAt)
 *   - Billable minutes: ceil(durationSeconds / 60), minimum 1
 *   - Negative duration: returns 0 billable minutes (clock skew safety)
 *   - Anomalous sessions (>24h): capped at MAX, flagged for manual review
 */
export function calculateBillableMinutes(
  params: BillableMinutesParams,
): BillableMinutesResult {
  const startResult = parseSafeTimestamp(params.joinedAt);
  if (!startResult.ok) {
    return err({
      ...startResult.error,
      message: `joinedAt parse error: ${startResult.error.message}`,
    });
  }

  const endResult = parseSafeTimestamp(params.leftAt);
  if (!endResult.ok) {
    return err({
      ...endResult.error,
      message: `leftAt parse error: ${endResult.error.message}`,
    });
  }

  const startMs = startResult.value.epochMs;
  const endMs   = endResult.value.epochMs;

  // Integer seconds — truncate, never round
  const rawDurationSeconds = Math.floor((endMs - startMs) / 1000);

  if (rawDurationSeconds < 0) {
    // Clock skew or re-ordered webhooks — defensive zero
    return ok({
      billableMinutes:       0,
      durationSeconds:       0,
      cappedDurationSeconds: 0,
      isAnomalous:           false,
      sessionStartAt:        new Date(startMs),
      sessionEndAt:          new Date(endMs),
    });
  }

  const isAnomalous = rawDurationSeconds > MAX_SESSION_SECONDS;
  const cappedDurationSeconds = isAnomalous
    ? MAX_SESSION_SECONDS
    : rawDurationSeconds;

  // Ceiling division — any started minute is a billed minute
  const rawMinutes = Math.ceil(cappedDurationSeconds / 60);

  // Enforce minimum billable unit
  const billableMinutes = Math.max(
    rawMinutes,
    cappedDurationSeconds > 0 ? BILLING_CONSTANTS.MIN_BILLABLE_MINUTES : 0,
  );

  return ok({
    billableMinutes,
    durationSeconds:       rawDurationSeconds,
    cappedDurationSeconds,
    isAnomalous,
    sessionStartAt:        new Date(startMs),
    sessionEndAt:          new Date(endMs),
  });
}

// ---------------------------------------------------------------------------
// Tier policy application
// ---------------------------------------------------------------------------

export type SubscriptionTier = "free" | "premium";

export interface TierPolicyParams {
  /** Calculated raw billable minutes for this session. */
  readonly sessionMinutes: number;
  /** Total minutes already consumed this billing period (pre-session). */
  readonly consumedMinutesThisPeriod: number;
  /** User's current subscription tier. */
  readonly tier: SubscriptionTier;
}

export interface TierPolicyValue {
  /**
   * Minutes to charge for this session (may be less than sessionMinutes
   * if the user hits their free-tier cap mid-session).
   */
  readonly chargeableMinutes: number;
  /**
   * Minutes covered by the free tier (not charged).
   */
  readonly freeMinutes: number;
  /**
   * Total minutes consumed after this session.
   */
  readonly totalConsumedAfter: number;
  /**
   * True if the user was over or hit their free cap during this session.
   */
  readonly isOverCap: boolean;
  /**
   * The cap value that was applied. 0 for premium (no cap).
   */
  readonly appliedCapMinutes: number;
}

export type TierPolicyResult = Result<TierPolicyValue>;

/**
 * Apply subscription-tier billing policy to a computed session.
 *
 * For FREE tier:
 *   - Monthly cap of FREE_TIER_MONTHLY_MINUTES
 *   - Minutes up to cap: free (chargeableMinutes = 0 for those minutes)
 *   - Minutes over cap: chargeable at per-minute rate
 *
 * For PREMIUM tier:
 *   - No usage cap; all minutes are chargeable (metered billing)
 *
 * This function does NOT make any payment API calls. It returns a
 * value object for the webhook handler to act on.
 */
export function applyTierPolicy(
  params: TierPolicyParams,
): TierPolicyResult {
  const { sessionMinutes, consumedMinutesThisPeriod, tier } = params;

  if (sessionMinutes < 0) {
    return err({
      code: "INVALID_INPUT",
      message: `sessionMinutes must be non-negative, got: ${sessionMinutes}`,
    });
  }

  if (consumedMinutesThisPeriod < 0) {
    return err({
      code: "INVALID_INPUT",
      message: `consumedMinutesThisPeriod must be non-negative, got: ${consumedMinutesThisPeriod}`,
    });
  }

  if (tier === "premium") {
    // Premium: flat metered billing, no cap
    return ok({
      chargeableMinutes:   sessionMinutes,
      freeMinutes:         0,
      totalConsumedAfter:  consumedMinutesThisPeriod + sessionMinutes,
      isOverCap:           false,
      appliedCapMinutes:   0,
    });
  }

  // Free tier cap logic
  const cap          = BILLING_CONSTANTS.FREE_TIER_MONTHLY_MINUTES;
  const remainingFree = Math.max(0, cap - consumedMinutesThisPeriod);

  // How many of this session's minutes are covered by remaining free allowance
  const freeMinutes       = Math.min(sessionMinutes, remainingFree);
  const chargeableMinutes = sessionMinutes - freeMinutes;

  return ok({
    chargeableMinutes,
    freeMinutes,
    totalConsumedAfter:  consumedMinutesThisPeriod + sessionMinutes,
    isOverCap:           chargeableMinutes > 0,
    appliedCapMinutes:   cap,
  });
}

// ---------------------------------------------------------------------------
// Billing period utility
// ---------------------------------------------------------------------------

/**
 * Return the billing period key for a given date as "YYYY-MM".
 *
 * Used to partition `consumedMinutesThisPeriod` queries and
 * to group Stripe meter events into monthly invoices.
 *
 * Always operates in UTC to prevent timezone-dependent billing discrepancies.
 */
export function formatBillingPeriod(date: Date): string {
  const year  = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Return the UTC start and end of the billing period containing `date`.
 * Useful for building the Supabase query to sum consumed minutes.
 */
export function getBillingPeriodBounds(date: Date): {
  readonly periodStart: Date;
  readonly periodEnd:   Date;
  readonly periodKey:   string;
} {
  const year  = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-indexed

  const periodStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const periodEnd   = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)); // exclusive

  return {
    periodStart,
    periodEnd,
    periodKey: formatBillingPeriod(date),
  };
}

// ---------------------------------------------------------------------------
// Participant identity parsing
// ---------------------------------------------------------------------------

/**
 * Parse the LiveKit participant identity string (format: "userId:deviceType")
 * minted in src/app/api/room/[id]/token/route.ts.
 *
 * Returns null if the identity doesn't match the expected format.
 */
export function parseParticipantIdentity(
  identity: string,
): { readonly userId: string; readonly deviceType: string } | null {
  const parts = identity.split(":");
  if (parts.length !== 2) return null;

  const [userId, deviceType] = parts;
  if (
    userId === undefined ||
    userId.trim().length === 0 ||
    deviceType === undefined ||
    deviceType.trim().length === 0
  ) {
    return null;
  }

  return { userId: userId.trim(), deviceType: deviceType.trim() };
}
