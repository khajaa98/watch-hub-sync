-- =============================================================================
-- Migration: 00005_create_billing.sql
-- Purpose  : Server-authoritative billing meter table. Written exclusively
--            by the LiveKit `room_finished` webhook handler using the
--            service_role key. Client RLS blocks all mutations from the browser.
--
--            Idempotency: Each LiveKit webhook carries a unique event_id.
--            We store it and use ON CONFLICT DO NOTHING to guarantee
--            exactly-once processing even if the webhook is retried.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TABLE: public.billing_meters
-- ---------------------------------------------------------------------------
CREATE TABLE public.billing_meters (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),

  -- The host is the billed party.
  host_id             UUID        NOT NULL REFERENCES public.users (id)   ON DELETE RESTRICT,

  -- Room this meter belongs to.
  room_id             UUID        NOT NULL REFERENCES public.rooms (id)   ON DELETE RESTRICT,

  -- Total billable participant-minutes: SUM(duration_per_participant).
  -- Calculated server-side by the webhook handler — never trusted from client.
  -- Formula: Σ participant_sessions × duration_minutes (rounded up per participant).
  participant_minutes NUMERIC(12, 4) NOT NULL DEFAULT 0 CHECK (participant_minutes >= 0),

  -- Raw session breakdown for audit / dispute resolution.
  -- Array of {user_id, device_type, duration_seconds, joined_at, left_at}
  session_breakdown   JSONB       NOT NULL DEFAULT '[]',

  -- Billing period this meter falls into (UTC month boundary).
  billing_period_start TIMESTAMPTZ NOT NULL,
  billing_period_end   TIMESTAMPTZ NOT NULL,

  -- Idempotency key sourced from LiveKit webhook event_id.
  -- UNIQUE constraint ensures duplicate webhooks are silently no-ops.
  livekit_event_id    TEXT        NOT NULL,

  -- Whether this meter has been forwarded to Stripe/Razorpay meter events API.
  is_processed        BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Stripe/Razorpay meter event ID returned after successful reporting.
  payment_event_id    TEXT,

  -- If processing failed, store the error for retry.
  processing_error    TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ,

  CONSTRAINT billing_meters_pkey PRIMARY KEY (id),

  -- Core idempotency guarantee: one meter row per LiveKit room_finished event.
  CONSTRAINT billing_meters_livekit_event_unique UNIQUE (livekit_event_id),

  -- A room should only produce one finalized meter.
  CONSTRAINT billing_meters_room_unique UNIQUE (room_id),

  -- Period consistency.
  CONSTRAINT billing_meters_period_order
    CHECK (billing_period_end > billing_period_start)
);

COMMENT ON TABLE public.billing_meters IS
  'Server-authoritative usage meter. Written only by webhook handlers (service_role). '
  'Idempotent on livekit_event_id. Immutable once is_processed = TRUE.';

COMMENT ON COLUMN public.billing_meters.participant_minutes IS
  'Billable participant-minutes: Σ ceil(duration_seconds/60) per participant session.';

COMMENT ON COLUMN public.billing_meters.livekit_event_id IS
  'LiveKit webhook event_id. UNIQUE — guarantees exactly-once meter creation.';

-- ---------------------------------------------------------------------------
-- Immutability guard: once is_processed = TRUE, the row cannot be modified.
-- Prevents retroactive tampering with finalized billing records.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_billing_meter_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_processed = TRUE THEN
    RAISE EXCEPTION
      'billing_meter % is already processed and immutable. '
      'Create a billing_adjustments record for corrections.',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_billing_meter_immutable
  BEFORE UPDATE ON public.billing_meters
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_billing_meter_immutability();

-- ---------------------------------------------------------------------------
-- Enable Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.billing_meters ENABLE ROW LEVEL SECURITY;

-- POLICY: Host can read their own billing meters (for dashboard display).
CREATE POLICY "billing_meters: host read own"
  ON public.billing_meters
  FOR SELECT
  USING (auth.uid() = host_id);

-- POLICY: Block ALL client-side mutations. Only service_role webhook handlers write here.
CREATE POLICY "billing_meters: deny client insert"
  ON public.billing_meters
  FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY "billing_meters: deny client update"
  ON public.billing_meters
  FOR UPDATE
  USING (FALSE);

CREATE POLICY "billing_meters: deny client delete"
  ON public.billing_meters
  FOR DELETE
  USING (FALSE);

COMMIT;
