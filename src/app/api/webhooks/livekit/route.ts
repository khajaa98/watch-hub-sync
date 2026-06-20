/**
 * src/app/api/webhooks/livekit/route.ts
 *
 * LiveKit Real-Time Usage Ingestion Webhook.
 *
 * ─── IDEMPOTENCY CONTRACT ────────────────────────────────────────────────────
 * LiveKit delivers webhooks "at least once" — duplicate events WILL arrive
 * during network retries. Every write to `billing_meters` is protected by a
 * PostgreSQL UNIQUE constraint on `livekit_event_id`. On constraint violation
 * (Postgres error code 23505), this handler returns 200 OK to swallow the
 * retry. Returning non-2xx would trigger infinite Svix/LiveKit re-delivery.
 *
 * Race condition prevention:
 *   - We use Supabase's `.upsert()` with `onConflict: 'livekit_event_id'`
 *     and `ignoreDuplicates: true`, which maps to `ON CONFLICT DO NOTHING`.
 *   - The billing table has RLS set to service_role only — this handler uses
 *     `createSupabaseServiceClient()`, bypassing row-level security.
 *   - The immutability trigger (set in Phase 1) prevents mutation of any row
 *     where `is_processed = TRUE`, making this upsert safe even if a
 *     downstream billing job runs concurrently.
 *
 * Handled events:
 *   - `participant_left`   → calculate session duration, upsert billing_meter
 *   - `room_finished`      → mark room as closed, trigger Stripe meter push
 *
 * Ignored events (200 OK, no-op):
 *   - `participant_joined` — join time is recorded from the participant_left event
 *   - `room_started`       — room creation is handled by POST /api/rooms
 *   - Any unrecognized event type
 *
 * LiveKit signature verification:
 *   LiveKit signs webhook bodies with a JWT using the LIVEKIT_API_SECRET.
 *   `WebhookReceiver.receive()` verifies this signature before we touch the
 *   payload. If verification fails, we return 401 without logging the body
 *   (to avoid leaking potentially-spoofed data into logs).
 */

import { NextResponse, type NextRequest } from "next/server";
import { WebhookReceiver } from "livekit-server-sdk";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createLogger } from "@/lib/logger";
import {
  calculateBillableMinutes,
  parseParticipantIdentity,
  getBillingPeriodBounds,
  applyTierPolicy,
  type SubscriptionTier,
} from "@/lib/billing/meter-calculator";
import { pushStripeParticipantMinutes } from "@/lib/billing/stripe-client";
import type { RoomRow, UserRow, BillingMeterRow } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Route config
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Disable Next.js body parsing — we need the raw body for signature verification.
// With App Router, this is handled by reading `request.text()` directly.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** PostgreSQL unique constraint violation error code. */
const PG_UNIQUE_VIOLATION = "23505" as const;

const log = createLogger({ module: "webhooks/livekit" });

// ---------------------------------------------------------------------------
// Lazy-initialized WebhookReceiver
// ---------------------------------------------------------------------------

let _receiver: WebhookReceiver | null = null;

function getReceiver(): WebhookReceiver {
  if (_receiver !== null) return _receiver;

  const apiKey    = process.env["LIVEKIT_API_KEY"];
  const apiSecret = process.env["LIVEKIT_API_SECRET"];

  if (
    apiKey === undefined || apiKey.trim().length === 0 ||
    apiSecret === undefined || apiSecret.trim().length === 0
  ) {
    throw new Error("LIVEKIT_API_KEY or LIVEKIT_API_SECRET is not configured");
  }

  _receiver = new WebhookReceiver(apiKey, apiSecret);
  return _receiver;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body BEFORE any other operation ───────────────────────────
  // This is critical: once .json() is called, .text() returns empty string.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (cause) {
    log.error({ cause }, "Failed to read request body");
    return NextResponse.json(
      { error: "Failed to read request body" },
      { status: 400 },
    );
  }

  if (rawBody.trim().length === 0) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  // ── 2. Cryptographic signature verification ───────────────────────────────
  const authHeader = request.headers.get("Authorization");

  let event: Awaited<ReturnType<WebhookReceiver["receive"]>>;
  try {
    event = await getReceiver().receive(rawBody, authHeader ?? undefined);
  } catch (cause) {
    // Do NOT log rawBody here — it could contain spoofed data
    log.warn({ cause: String(cause) }, "LiveKit webhook signature verification failed");
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 401 },
    );
  }

  const eventType = event.event;
  const eventId   = event.id ?? `synthetic_${Date.now()}`;

  log.info({ eventType, eventId }, "LiveKit webhook received");

  // ── 3. Route to handler ───────────────────────────────────────────────────
  try {
    switch (eventType) {
      case "participant_left":
        await handleParticipantLeft(event, eventId);
        break;

      case "room_finished":
        await handleRoomFinished(event, eventId);
        break;

      default:
        // Unknown events get 200 — LiveKit may add new event types without notice.
        log.debug({ eventType }, "Ignoring unhandled LiveKit event type");
    }
  } catch (cause) {
    // Non-idempotency errors — log and return 500 to trigger LiveKit retry
    log.error({ cause, eventType, eventId }, "LiveKit webhook handler error");
    return NextResponse.json(
      { error: "Handler failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// participant_left handler
// ---------------------------------------------------------------------------

async function handleParticipantLeft(
  event: Awaited<ReturnType<WebhookReceiver["receive"]>>,
  eventId: string,
): Promise<void> {
  const participant = event.participant;
  const room        = event.room;

  if (participant === undefined || participant === null) {
    log.warn({ eventId }, "participant_left event missing participant data");
    return;
  }

  if (room === undefined || room === null) {
    log.warn({ eventId }, "participant_left event missing room data");
    return;
  }

  // Parse identity back to userId:deviceType
  const identity = participant.identity ?? "";
  const parsed   = parseParticipantIdentity(identity);

  if (parsed === null) {
    log.warn(
      { identity, eventId },
      "Could not parse participant identity — skipping billing",
    );
    return;
  }

  const { userId, deviceType } = parsed;

  // We only bill on PRIMARY device sessions. Remote/companion screens are the
  // same user on the same content — billing both would double-count.
  if (deviceType === "remote") {
    log.debug({ identity, eventId }, "Skipping billing for remote device session");
    return;
  }

  // ── Calculate session duration ───────────────────────────────────────────
  // LiveKit provides joinedAt as bigint (Unix seconds).
  // The event's createdAt is the leave time (when LiveKit generated this event).
  const joinedAt = participant.joinedAt;  // bigint seconds
  const leftAt   = event.createdAt;       // Unix seconds (number)

  const durationResult = calculateBillableMinutes({
    joinedAt,
    leftAt,
  });

  if (!durationResult.ok) {
    log.error(
      { error: durationResult.error, eventId, identity },
      "Billing duration calculation failed",
    );
    // Return without re-throwing — a bad webhook payload shouldn't cause retries
    return;
  }

  const {
    billableMinutes,
    durationSeconds,
    isAnomalous,
    sessionStartAt,
    sessionEndAt,
  } = durationResult.value;

  if (isAnomalous) {
    log.warn(
      { eventId, identity, durationSeconds },
      "Anomalous session duration — capped and flagged",
    );
  }

  // ── Look up room by LiveKit room name ────────────────────────────────────
  const supabase = createSupabaseServiceClient();

  const { data: dbRoomRaw, error: roomError } = await supabase
    .from("rooms")
    .select("id, host_id")
    .eq("livekit_room_name", room.name ?? "")
    .single();
  const dbRoom = dbRoomRaw as unknown as RoomRow | null;

  if (roomError !== null || dbRoom === null) {
    log.error(
      { roomName: room.name, roomError, eventId },
      "Could not find room by livekit_room_name",
    );
    return;
  }

  // ── Look up user's subscription tier ────────────────────────────────────
  const { data: userProfileRaw } = await supabase
    .from("users")
    .select("subscription_tier, stripe_customer_id")
    .eq("id", userId)
    .single();
  const userProfile = userProfileRaw as unknown as UserRow | null;

  const tier = (userProfile?.subscription_tier ?? "free") as SubscriptionTier;
  const stripeCustomerId = userProfile?.stripe_customer_id ?? null;

  // ── Fetch consumed minutes this billing period ───────────────────────────
  const { periodStart, periodEnd } = getBillingPeriodBounds(sessionEndAt);

  const { data: consumedDataRaw } = await supabase
    .from("billing_meters")
    .select("participant_minutes")
    .eq("user_id", userId)
    .gte("session_end_at", periodStart.toISOString())
    .lt("session_end_at", periodEnd.toISOString())
    .eq("is_processed", false);
  const consumedData = consumedDataRaw as unknown as Pick<BillingMeterRow, "participant_minutes">[] | null;

  const consumedMinutesThisPeriod =
    consumedData?.reduce(
      (sum: number, row: { participant_minutes: number }) =>
        sum + (row.participant_minutes ?? 0),
      0,
    ) ?? 0;

  // ── Apply tier policy ────────────────────────────────────────────────────
  const policyResult = applyTierPolicy({
    sessionMinutes: billableMinutes,
    consumedMinutesThisPeriod,
    tier,
  });

  if (!policyResult.ok) {
    log.error({ error: policyResult.error, eventId }, "Tier policy application failed");
    return;
  }

  const { chargeableMinutes } = policyResult.value;

  // ── Idempotent upsert into billing_meters ────────────────────────────────
  //
  // ON CONFLICT DO NOTHING — if this eventId has already been processed
  // (duplicate delivery), the upsert is a no-op and data remains untouched.
  const { error: upsertError } = await supabase
    .from("billing_meters")
    .upsert(
      {
        room_id:              dbRoom.id,
        host_id:              dbRoom.host_id,
        livekit_event_id:     eventId,
        billing_period_start: sessionStartAt.toISOString(),
        billing_period_end:   sessionEndAt.toISOString(),
        participant_minutes:  billableMinutes,
        is_processed:         false,
        // chargeable_minutes and is_anomalous stored in session_breakdown for audit
        session_breakdown: {
          user_id:            userId,
          chargeable_minutes: chargeableMinutes,
          is_anomalous:       isAnomalous,
        },
      },
      {
        onConflict:       "livekit_event_id",
        ignoreDuplicates: true,
      },
    );

  if (upsertError !== null) {
    // Check for unique violation — safe to swallow
    const pgCode = (upsertError as { code?: string }).code;
    if (pgCode === PG_UNIQUE_VIOLATION) {
      log.info({ eventId }, "Duplicate billing event — idempotently swallowed");
      return;
    }
    throw new Error(`billing_meters upsert failed: ${upsertError.message}`);
  }

  log.info(
    {
      eventId,
      userId,
      deviceType,
      durationSeconds,
      billableMinutes,
      chargeableMinutes,
      tier,
    },
    "Billing meter upserted",
  );

  // ── Real-time Stripe push for premium users ──────────────────────────────
  // Premium users are billed per-minute in real-time; free users are invoiced
  // monthly after tier caps are applied by the batch job.
  if (tier === "premium" && stripeCustomerId !== null && chargeableMinutes > 0) {
    // Fetch the newly inserted meter ID for the idempotency key
    const { data: newMeterRaw } = await supabase
      .from("billing_meters")
      .select("id")
      .eq("livekit_event_id", eventId)
      .single();
    const newMeter = newMeterRaw as unknown as Pick<BillingMeterRow, "id"> | null;

    if (newMeter !== null) {
      try {
        await pushStripeParticipantMinutes([
          {
            billingMeterId:      newMeter.id,
            stripeCustomerId,
            participantMinutes:  chargeableMinutes,
            sessionEndAt,
          },
        ]);

        // Mark as processed so the batch job skips it
        await supabase
          .from("billing_meters")
          .update({ is_processed: true })
          .eq("id", newMeter.id);

        log.info(
          { eventId, stripeCustomerId, chargeableMinutes },
          "Stripe meter event pushed (premium real-time)",
        );
      } catch (stripeErr) {
        // Don't throw — the billing_meter record exists and the batch job
        // will pick it up on its next run. Log for alerting.
        log.error(
          { stripeErr, eventId, stripeCustomerId },
          "Real-time Stripe push failed — will be retried by batch job",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// room_finished handler
// ---------------------------------------------------------------------------

async function handleRoomFinished(
  event: Awaited<ReturnType<WebhookReceiver["receive"]>>,
  eventId: string,
): Promise<void> {
  const room = event.room;

  if (room === undefined || room === null) {
    log.warn({ eventId }, "room_finished event missing room data");
    return;
  }

  const supabase = createSupabaseServiceClient();

  // ── Mark room as closed ──────────────────────────────────────────────────
  const { error: updateError } = await supabase
    .from("rooms")
    .update({ status: "closed" })
    .eq("livekit_room_name", room.name ?? "")
    .neq("status", "closed"); // No-op if already closed (idempotent)

  if (updateError !== null) {
    throw new Error(`Failed to close room: ${updateError.message}`);
  }

  log.info({ roomName: room.name, eventId }, "Room marked as closed");

  // ── Batch-push any unprocessed free-tier meters for this room ────────────
  // After room_finished we do a final sweep so free-tier users are also
  // pushed to Stripe if their chargeable_minutes > 0 (i.e., they exceeded cap).

  const { data: dbRoomFinishedRaw } = await supabase
    .from("rooms")
    .select("id")
    .eq("livekit_room_name", room.name ?? "")
    .single();
  const dbRoom = dbRoomFinishedRaw as unknown as Pick<RoomRow, "id"> | null;

  if (dbRoom === null) return;

  type UnprocessedMeter = {
    id: string;
    billing_period_end: string;
    session_breakdown: { user_id?: string; chargeable_minutes?: number } | null;
    users: { stripe_customer_id: string | null } | null;
  };

  const { data: unprocessedMetersRaw } = await supabase
    .from("billing_meters")
    .select(
      "id, billing_period_end, session_breakdown, users(stripe_customer_id)",
    )
    .eq("room_id", dbRoom.id)
    .eq("is_processed", false);
  const unprocessedMeters = unprocessedMetersRaw as unknown as UnprocessedMeter[] | null;

  if (unprocessedMeters === null || unprocessedMeters.length === 0) {
    log.info({ roomId: dbRoom.id }, "No unprocessed chargeable meters after room_finished");
    return;
  }

  const stripePushEvents = unprocessedMeters
    .filter((m) => {
      const hasCustomer = m.users?.stripe_customer_id != null;
      const chargeableMinutes = (m.session_breakdown?.chargeable_minutes ?? 0);
      return hasCustomer && chargeableMinutes > 0;
    })
    .map((m) => ({
      billingMeterId:     m.id,
      stripeCustomerId:   m.users!.stripe_customer_id as string,
      participantMinutes: m.session_breakdown?.chargeable_minutes ?? 0,
      sessionEndAt:       new Date(m.billing_period_end),
    }));

  if (stripePushEvents.length === 0) {
    log.info({ roomId: dbRoom.id }, "No Stripe customers to push meters for");
    return;
  }

  try {
    const { pushed, skipped } = await pushStripeParticipantMinutes(stripePushEvents);

    // Mark all successfully-pushed meters as processed
    const processedIds = stripePushEvents
      .slice(0, pushed + skipped)
      .map((e) => e.billingMeterId);

    if (processedIds.length > 0) {
      await supabase
        .from("billing_meters")
        .update({ is_processed: true })
        .in("id", processedIds);
    }

    log.info(
      { pushed, skipped, roomId: dbRoom.id },
      "Batch Stripe push completed on room_finished",
    );
  } catch (stripeErr) {
    log.error(
      { stripeErr, roomId: dbRoom.id },
      "Batch Stripe push failed on room_finished — will retry on next billing cycle",
    );
    // Do not re-throw — room is already marked closed; meters remain for retry
  }
}
