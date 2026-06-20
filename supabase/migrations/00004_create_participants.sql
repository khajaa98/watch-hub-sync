-- =============================================================================
-- Migration: 00004_create_participants.sql
-- Purpose  : Tracks every user–room membership event. A single user can
--            appear twice (primary device + remote device). This is
--            intentional and modeled by the `device_type` column.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TABLE: public.participants
-- ---------------------------------------------------------------------------
CREATE TABLE public.participants (
  id           UUID                  NOT NULL DEFAULT gen_random_uuid(),

  room_id      UUID                  NOT NULL REFERENCES public.rooms (id)   ON DELETE CASCADE,
  user_id      UUID                  NOT NULL REFERENCES public.users (id)   ON DELETE CASCADE,

  role         public.participant_role NOT NULL DEFAULT 'guest',

  device_type  public.device_type    NOT NULL DEFAULT 'primary',

  -- LiveKit participant identity (format: "{user_id}:{device_type}").
  -- Used to correlate LiveKit webhook events back to this row.
  livekit_identity TEXT,

  -- Geo metadata captured at join time (country_code, region).
  geo_metadata JSONB DEFAULT '{}',

  joined_at    TIMESTAMPTZ           NOT NULL DEFAULT NOW(),

  -- NULL while participant is still in the room.
  left_at      TIMESTAMPTZ,

  CONSTRAINT participants_pkey PRIMARY KEY (id),

  -- A user may only have one active session per room per device type.
  -- "Active" = left_at IS NULL.
  CONSTRAINT participants_unique_active_device
    UNIQUE NULLS NOT DISTINCT (room_id, user_id, device_type, left_at)
);

COMMENT ON TABLE public.participants IS
  'Room membership log. One row per join event. Dual-device users have two rows.';

COMMENT ON COLUMN public.participants.livekit_identity IS
  'Correlates LiveKit webhook participant events to DB rows. Format: {user_id}:{device_type}.';

-- ---------------------------------------------------------------------------
-- updated_at — participants are append-only except for left_at, so
-- we only need a minimal trigger for left_at population consistency.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_participant_left_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Prevent a participant from being "re-joined" by nullifying left_at
  -- on an existing closed row (immutability guarantee on closed rows).
  IF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL THEN
    RAISE EXCEPTION
      'Participant row % is already closed (left_at=%). Create a new row for re-join.',
      OLD.id, OLD.left_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_participants_immutable_left
  BEFORE UPDATE ON public.participants
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_participant_left_at();

-- ---------------------------------------------------------------------------
-- Enable Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;

-- POLICY: A participant can see their own participation rows.
CREATE POLICY "participants: self read"
  ON public.participants
  FOR SELECT
  USING (auth.uid() = user_id);

-- POLICY: A host can see all participants in rooms they own.
CREATE POLICY "participants: host read room"
  ON public.participants
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.rooms r
      WHERE r.id = public.participants.room_id
        AND r.host_id = auth.uid()
    )
  );

-- POLICY: Users can only insert themselves as a participant.
-- Prevents a client from inserting a row on behalf of another user.
CREATE POLICY "participants: self insert"
  ON public.participants
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- POLICY: A participant can update only their own row (e.g., mark left_at).
-- Service role (webhook handler) updates without RLS.
CREATE POLICY "participants: self update"
  ON public.participants
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- POLICY: No client-side deletes — rows are the billing audit trail.
CREATE POLICY "participants: deny delete"
  ON public.participants
  FOR DELETE
  USING (FALSE);

-- ---------------------------------------------------------------------------
-- Back-fill: rooms policy that references public.participants
-- This policy belongs logically to the rooms table but could not be created
-- in 00003_create_rooms.sql because participants did not exist yet.
-- PostgreSQL validates sub-select relation references at CREATE POLICY time.
-- ---------------------------------------------------------------------------
CREATE POLICY "rooms: participant read"
  ON public.rooms
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.participants p
      WHERE p.room_id = public.rooms.id
        AND p.user_id = auth.uid()
    )
  );

COMMIT;
