/**
 * src/lib/billing/__tests__/meter-calculator.test.ts
 *
 * Unit Tests — Billing Meter Calculator.
 *
 * These tests are the billing integrity gate in CI. Every merge to `main`
 * must pass all tests here before code ships to production.
 *
 * The module under test is pure (no I/O, no network, no DB). Tests run in
 * < 100ms and require zero infrastructure.
 *
 * Test surface:
 *   - parseSafeTimestamp: format acceptance/rejection, timezone enforcement
 *   - calculateBillableMinutes: ceiling arithmetic, zero/negative/anomalous
 *   - applyTierPolicy: free cap, premium, cross-boundary sessions
 *   - getBillingPeriodBounds: UTC month alignment
 *   - formatBillingPeriod: YYYY-MM format
 *   - parseParticipantIdentity: identity string parsing
 */

import { describe, it, expect } from "vitest";
import {
  parseSafeTimestamp,
  calculateBillableMinutes,
  applyTierPolicy,
  getBillingPeriodBounds,
  formatBillingPeriod,
  parseParticipantIdentity,
  BILLING_CONSTANTS,
} from "../meter-calculator";

// ---------------------------------------------------------------------------
// parseSafeTimestamp
// ---------------------------------------------------------------------------

describe("parseSafeTimestamp", () => {
  it("accepts ISO-8601 with Z suffix", () => {
    const result = parseSafeTimestamp("2024-08-15T12:30:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.epochMs).toBe(new Date("2024-08-15T12:30:00.000Z").getTime());
    }
  });

  it("accepts ISO-8601 with +05:30 offset (IST)", () => {
    const result = parseSafeTimestamp("2024-08-15T18:00:00+05:30");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 18:00 IST = 12:30 UTC
      const expected = new Date("2024-08-15T12:30:00.000Z").getTime();
      expect(result.value.epochMs).toBe(expected);
    }
  });

  it("accepts Unix epoch seconds (number < 1e10)", () => {
    const epoch = 1723724400; // 2024-08-15T12:00:00Z
    const result = parseSafeTimestamp(epoch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.epochMs).toBe(epoch * 1000);
    }
  });

  it("accepts Unix epoch milliseconds (number >= 1e10)", () => {
    const epochMs = 1723724400000;
    const result = parseSafeTimestamp(epochMs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.epochMs).toBe(epochMs);
    }
  });

  it("accepts BigInt seconds (LiveKit protobuf format)", () => {
    const result = parseSafeTimestamp(BigInt(1723724400));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.epochMs).toBe(1723724400000);
    }
  });

  it("rejects ISO-8601 without timezone (no Z, no offset)", () => {
    const result = parseSafeTimestamp("2024-08-15T12:30:00");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MISSING_TIMEZONE");
    }
  });

  it("rejects null", () => {
    const result = parseSafeTimestamp(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects undefined", () => {
    const result = parseSafeTimestamp(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects empty string", () => {
    const result = parseSafeTimestamp("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects NaN numeric timestamp", () => {
    const result = parseSafeTimestamp(NaN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TIMESTAMP");
    }
  });

  it("rejects completely unparseable string", () => {
    const result = parseSafeTimestamp("not-a-date");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TIMESTAMP");
    }
  });

  it("rejects object type input", () => {
    const result = parseSafeTimestamp({ date: "2024-01-01" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});

// ---------------------------------------------------------------------------
// calculateBillableMinutes
// ---------------------------------------------------------------------------

describe("calculateBillableMinutes", () => {
  const join = "2024-08-15T10:00:00.000Z";

  it("bills a 60-second session as 1 minute (exact boundary)", () => {
    const left = "2024-08-15T10:01:00.000Z";
    const result = calculateBillableMinutes({ joinedAt: join, leftAt: left });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.billableMinutes).toBe(1);
      expect(result.value.durationSeconds).toBe(60);
    }
  });

  it("bills a 61-second session as 2 minutes (ceiling)", () => {
    const left = "2024-08-15T10:01:01.000Z";
    const result = calculateBillableMinutes({ joinedAt: join, leftAt: left });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.billableMinutes).toBe(2);
      expect(result.value.durationSeconds).toBe(61);
    }
  });

  it("bills a 30-second session as 1 minute (minimum floor)", () => {
    const left = "2024-08-15T10:00:30.000Z";
    const result = calculateBillableMinutes({ joinedAt: join, leftAt: left });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.billableMinutes).toBe(1);
    }
  });

  it("bills a 1-second session as 1 minute (minimum floor)", () => {
    const left = "2024-08-15T10:00:01.000Z";
    const result = calculateBillableMinutes({ joinedAt: join, leftAt: left });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.billableMinutes).toBe(1);
    }
  });

  it("bills a 90-minute session as 90 minutes (exact)", () => {
    const left = "2024-08-15T11:30:00.000Z";
    const result = calculateBillableMinutes({ joinedAt: join, leftAt: left });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.billableMinutes).toBe(90);
      expect(result.value.durationSeconds).toBe(90 * 60);
    }
  });

  it("returns 0 billable minutes for negative duration (clock skew)", () => {
    // leftAt is BEFORE joinedAt — clock skew or re-ordered webhook delivery
    const result = calculateBillableMinutes({
      joinedAt: "2024-08-15T10:01:00.000Z",
      leftAt:   "2024-08-15T10:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.billableMinutes).toBe(0);
      expect(result.value.durationSeconds).toBe(0);
      expect(result.value.isAnomalous).toBe(false);
    }
  });

  it("caps and flags anomalous sessions (> 24 hours)", () => {
    const left = "2024-08-16T10:01:00.000Z"; // 24h 1m after join
    const result = calculateBillableMinutes({ joinedAt: join, leftAt: left });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isAnomalous).toBe(true);
      expect(result.value.cappedDurationSeconds).toBe(
        BILLING_CONSTANTS.MAX_SESSION_DURATION_HOURS * 60 * 60,
      );
      expect(result.value.billableMinutes).toBe(
        BILLING_CONSTANTS.MAX_SESSION_DURATION_HOURS * 60,
      );
    }
  });

  it("returns error for invalid joinedAt", () => {
    const result = calculateBillableMinutes({
      joinedAt: "not-a-date",
      leftAt:   join,
    });
    expect(result.ok).toBe(false);
  });

  it("returns error for invalid leftAt", () => {
    const result = calculateBillableMinutes({
      joinedAt: join,
      leftAt:   "2024-08-15T10:00:00", // no timezone — rejected
    });
    expect(result.ok).toBe(false);
  });

  it("accepts BigInt joinedAt (LiveKit protobuf format)", () => {
    const joinEpochS = BigInt(1723719600); // 2024-08-15T10:00:00Z
    const leftEpochS = BigInt(1723719660); // 2024-08-15T10:01:00Z
    const result = calculateBillableMinutes({
      joinedAt: joinEpochS,
      leftAt:   leftEpochS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.billableMinutes).toBe(1);
    }
  });

  it("returns correct sessionStartAt and sessionEndAt as Date objects", () => {
    const left = "2024-08-15T10:05:00.000Z";
    const result = calculateBillableMinutes({ joinedAt: join, leftAt: left });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessionStartAt).toBeInstanceOf(Date);
      expect(result.value.sessionEndAt).toBeInstanceOf(Date);
      expect(result.value.sessionStartAt.toISOString()).toBe(join);
      expect(result.value.sessionEndAt.toISOString()).toBe(left);
    }
  });
});

// ---------------------------------------------------------------------------
// applyTierPolicy
// ---------------------------------------------------------------------------

describe("applyTierPolicy", () => {
  const CAP = BILLING_CONSTANTS.FREE_TIER_MONTHLY_MINUTES; // 120

  describe("premium tier", () => {
    it("bills all minutes at premium — no cap applied", () => {
      const result = applyTierPolicy({
        sessionMinutes: 60,
        consumedMinutesThisPeriod: 500,
        tier: "premium",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chargeableMinutes).toBe(60);
        expect(result.value.freeMinutes).toBe(0);
        expect(result.value.isOverCap).toBe(false);
        expect(result.value.appliedCapMinutes).toBe(0);
      }
    });

    it("bills even when consumed minutes are 0 (premium first session)", () => {
      const result = applyTierPolicy({
        sessionMinutes: 15,
        consumedMinutesThisPeriod: 0,
        tier: "premium",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chargeableMinutes).toBe(15);
        expect(result.value.totalConsumedAfter).toBe(15);
      }
    });
  });

  describe("free tier", () => {
    it("first session within cap is fully free", () => {
      const result = applyTierPolicy({
        sessionMinutes: 30,
        consumedMinutesThisPeriod: 0,
        tier: "free",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chargeableMinutes).toBe(0);
        expect(result.value.freeMinutes).toBe(30);
        expect(result.value.isOverCap).toBe(false);
        expect(result.value.totalConsumedAfter).toBe(30);
      }
    });

    it("session that exactly hits the cap is fully free", () => {
      const result = applyTierPolicy({
        sessionMinutes: CAP,
        consumedMinutesThisPeriod: 0,
        tier: "free",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chargeableMinutes).toBe(0);
        expect(result.value.freeMinutes).toBe(CAP);
        expect(result.value.isOverCap).toBe(false);
      }
    });

    it("session that crosses the cap boundary is split correctly", () => {
      // 110 already consumed, 20-minute session → 10 free, 10 chargeable
      const result = applyTierPolicy({
        sessionMinutes: 20,
        consumedMinutesThisPeriod: 110,
        tier: "free",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.freeMinutes).toBe(10);
        expect(result.value.chargeableMinutes).toBe(10);
        expect(result.value.isOverCap).toBe(true);
        expect(result.value.totalConsumedAfter).toBe(130);
      }
    });

    it("session entirely over cap is fully chargeable", () => {
      const result = applyTierPolicy({
        sessionMinutes: 30,
        consumedMinutesThisPeriod: CAP, // already at cap
        tier: "free",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.freeMinutes).toBe(0);
        expect(result.value.chargeableMinutes).toBe(30);
        expect(result.value.isOverCap).toBe(true);
      }
    });

    it("zero-minute session produces zero chargeable", () => {
      const result = applyTierPolicy({
        sessionMinutes: 0,
        consumedMinutesThisPeriod: 50,
        tier: "free",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chargeableMinutes).toBe(0);
        expect(result.value.freeMinutes).toBe(0);
      }
    });
  });

  describe("input validation", () => {
    it("returns error for negative sessionMinutes", () => {
      const result = applyTierPolicy({
        sessionMinutes: -5,
        consumedMinutesThisPeriod: 0,
        tier: "free",
      });
      expect(result.ok).toBe(false);
    });

    it("returns error for negative consumedMinutesThisPeriod", () => {
      const result = applyTierPolicy({
        sessionMinutes: 5,
        consumedMinutesThisPeriod: -1,
        tier: "free",
      });
      expect(result.ok).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// getBillingPeriodBounds
// ---------------------------------------------------------------------------

describe("getBillingPeriodBounds", () => {
  it("returns UTC month start and exclusive end", () => {
    const date   = new Date("2024-08-15T10:30:00.000Z");
    const bounds = getBillingPeriodBounds(date);

    expect(bounds.periodStart.toISOString()).toBe("2024-08-01T00:00:00.000Z");
    expect(bounds.periodEnd.toISOString()).toBe("2024-09-01T00:00:00.000Z");
    expect(bounds.periodKey).toBe("2024-08");
  });

  it("handles December → January rollover", () => {
    const date   = new Date("2024-12-31T23:59:59.000Z");
    const bounds = getBillingPeriodBounds(date);

    expect(bounds.periodStart.toISOString()).toBe("2024-12-01T00:00:00.000Z");
    expect(bounds.periodEnd.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(bounds.periodKey).toBe("2024-12");
  });

  it("handles the first day of a month correctly", () => {
    const date   = new Date("2024-01-01T00:00:00.000Z");
    const bounds = getBillingPeriodBounds(date);

    expect(bounds.periodKey).toBe("2024-01");
    expect(bounds.periodStart.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("does not depend on local timezone", () => {
    // IST midnight is 2024-08-15T18:30:00Z the previous UTC day
    // The billing period must be based on UTC, not IST
    const date   = new Date("2024-08-16T00:00:00+05:30"); // Aug 16 00:00 IST = Aug 15 18:30 UTC
    const bounds = getBillingPeriodBounds(date);

    // This should be August (UTC), not September
    expect(bounds.periodKey).toBe("2024-08");
  });
});

// ---------------------------------------------------------------------------
// formatBillingPeriod
// ---------------------------------------------------------------------------

describe("formatBillingPeriod", () => {
  it("formats year-month with zero-padded month", () => {
    expect(formatBillingPeriod(new Date("2024-01-15T00:00:00.000Z"))).toBe("2024-01");
    expect(formatBillingPeriod(new Date("2024-09-01T00:00:00.000Z"))).toBe("2024-09");
    expect(formatBillingPeriod(new Date("2024-12-31T00:00:00.000Z"))).toBe("2024-12");
  });
});

// ---------------------------------------------------------------------------
// parseParticipantIdentity
// ---------------------------------------------------------------------------

describe("parseParticipantIdentity", () => {
  it("parses valid userId:deviceType identity", () => {
    const result = parseParticipantIdentity(
      "123e4567-e89b-12d3-a456-426614174000:primary",
    );
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(result?.deviceType).toBe("primary");
  });

  it("parses remote device type", () => {
    const result = parseParticipantIdentity(
      "abc123:remote",
    );
    expect(result).not.toBeNull();
    expect(result?.deviceType).toBe("remote");
  });

  it("returns null for identity without colon separator", () => {
    expect(parseParticipantIdentity("userId-only")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseParticipantIdentity("")).toBeNull();
  });

  it("returns null for identity with empty userId", () => {
    expect(parseParticipantIdentity(":primary")).toBeNull();
  });

  it("returns null for identity with empty deviceType", () => {
    expect(parseParticipantIdentity("userId:")).toBeNull();
  });

  it("returns null if more than one colon (extra segments)", () => {
    // "uuid:primary:extra" has 3 parts — our format only has 2
    expect(parseParticipantIdentity("uuid:primary:extra")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration scenario: full session billing flow
// ---------------------------------------------------------------------------

describe("Full session billing flow (integration)", () => {
  it("calculates and applies policy for a premium user's typical session", () => {
    // 45-minute premium session with 200 minutes already consumed this period
    const durationResult = calculateBillableMinutes({
      joinedAt: "2024-08-15T10:00:00.000Z",
      leftAt:   "2024-08-15T10:45:00.000Z",
    });

    expect(durationResult.ok).toBe(true);
    if (!durationResult.ok) return;

    const policyResult = applyTierPolicy({
      sessionMinutes:            durationResult.value.billableMinutes,
      consumedMinutesThisPeriod: 200,
      tier:                      "premium",
    });

    expect(policyResult.ok).toBe(true);
    if (!policyResult.ok) return;

    expect(durationResult.value.billableMinutes).toBe(45);
    expect(policyResult.value.chargeableMinutes).toBe(45);
    expect(policyResult.value.isOverCap).toBe(false); // Premium has no cap
  });

  it("correctly splits a free-tier user's session that crosses the monthly cap", () => {
    // Free tier user with 115/120 minutes used, doing a 10-minute session
    // → 5 minutes free + 5 minutes chargeable
    const durationResult = calculateBillableMinutes({
      joinedAt: "2024-08-15T10:00:00.000Z",
      leftAt:   "2024-08-15T10:10:00.000Z",
    });

    expect(durationResult.ok).toBe(true);
    if (!durationResult.ok) return;
    expect(durationResult.value.billableMinutes).toBe(10);

    const policyResult = applyTierPolicy({
      sessionMinutes:            10,
      consumedMinutesThisPeriod: 115,
      tier:                      "free",
    });

    expect(policyResult.ok).toBe(true);
    if (!policyResult.ok) return;

    expect(policyResult.value.freeMinutes).toBe(5);
    expect(policyResult.value.chargeableMinutes).toBe(5);
    expect(policyResult.value.isOverCap).toBe(true);
    expect(policyResult.value.totalConsumedAfter).toBe(125);
  });
});
