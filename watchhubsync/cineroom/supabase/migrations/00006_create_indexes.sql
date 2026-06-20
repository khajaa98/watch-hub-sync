-- =============================================================================
-- Migration: 00006_create_indexes.sql
-- Purpose  : Performance indexes on hot query paths.
--            All indexes are CONCURRENTLY-safe (add CONCURRENTLY in prod
--            migrations against a live database to avoid table locks).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

-- Webhook handlers look up users by Stripe customer ID.
CREATE INDEX idx_users_stripe_customer_id
  ON public.users (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Webhook handlers look up users by Razorpay customer ID.
CREATE INDEX idx_users_razorpay_customer_id
  ON public.users (razorpay_customer_id)
  WHERE razorpay_customer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------

-- Host dashboard loads all rooms for a given host, ordered by recency.
CREATE INDEX idx_rooms_host_id_created_at
  ON public.rooms (host_id, created_at DESC);

-- LiveKit webhook handler looks up rooms by livekit_room_name.
CREATE INDEX idx_rooms_livekit_room_name
  ON public.rooms (livekit_room_name)
  WHERE livekit_room_name IS NOT NULL;

-- Filter active rooms for a host (dashboard "live" view).
CREATE INDEX idx_rooms_host_status
  ON public.rooms (host_id, status)
  WHERE status IN ('waiting', 'active');

-- ---------------------------------------------------------------------------
-- participants
-- ---------------------------------------------------------------------------

-- Most common query: "who is in this room right now?"
CREATE INDEX idx_participants_room_id_active
  ON public.participants (room_id, joined_at DESC)
  WHERE left_at IS NULL;

-- Billing webhook: look up all participants for a room (including departed).
CREATE INDEX idx_participants_room_id_all
  ON public.participants (room_id);

-- User history: "which rooms have I been in?"
CREATE INDEX idx_participants_user_id_joined
  ON public.participants (user_id, joined_at DESC);

-- LiveKit identity correlation (webhook handler).
CREATE INDEX idx_participants_livekit_identity
  ON public.participants (livekit_identity)
  WHERE livekit_identity IS NOT NULL;

-- ---------------------------------------------------------------------------
-- billing_meters
-- ---------------------------------------------------------------------------

-- Host billing dashboard.
CREATE INDEX idx_billing_meters_host_id_period
  ON public.billing_meters (host_id, billing_period_start DESC);

-- Unprocessed meters for the background retry job.
CREATE INDEX idx_billing_meters_unprocessed
  ON public.billing_meters (created_at ASC)
  WHERE is_processed = FALSE;

COMMIT;
