-- =============================================================================
-- Migration: 00003_create_rooms.sql
-- Purpose  : Watch-together rooms. A room is a logical sync session.
--            It owns: platform config, playback state, and invite tokens.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TABLE: public.rooms
-- ---------------------------------------------------------------------------
CREATE TABLE public.rooms (
  id              UUID            NOT NULL DEFAULT gen_random_uuid(),

  host_id         UUID            NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,

  status          public.room_status NOT NULL DEFAULT 'waiting',

  platform        public.platform NOT NULL,

  -- Flexible JSONB bag for platform-specific settings and room config:
  -- {
  --   "content_id": "dQw4w9WgXcQ",           -- YouTube video ID / Hotstar content ID
  --   "content_title": "Kalki 2898 AD",
  --   "content_thumbnail": "https://...",
  --   "max_participants": 10,                 -- 0 = unlimited (premium only)
  --   "require_approval": true,               -- Host must approve each guest
  --   "has_international_guests": false,      -- Triggers geo-compat checker
  --   "allow_chat": true,
  --   "allow_reactions": true,
  --   "sync_tolerance_ms": 2000               -- Seek threshold before hard-sync
  -- }
  settings        JSONB           NOT NULL DEFAULT '{}',

  -- LiveKit room name derived at creation (immutable, used as FK into LK cloud).
  livekit_room_name TEXT          UNIQUE,

  -- Signed invite token (HMAC-SHA256). Rotated on each invite regeneration.
  -- Stored as a hash; the raw token is never persisted.
  invite_token_hash TEXT,

  -- Token expiry. NULL = token has been invalidated / room closed.
  invite_expires_at TIMESTAMPTZ,

  -- Soft reference to the geo-check result at creation time.
  -- Allows auditing of compat warnings shown to host.
  geo_check_result  JSONB,

  -- Server-side tracking of playback state for reconciliation on late joins.
  -- {
  --   "is_playing": true,
  --   "position_seconds": 142.5,
  --   "last_sync_at": "2024-01-01T12:00:00Z"
  -- }
  playback_state    JSONB         NOT NULL DEFAULT '{"is_playing": false, "position_seconds": 0}',

  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,

  CONSTRAINT rooms_pkey PRIMARY KEY (id),

  -- Enforce: a room without a host is invalid.
  CONSTRAINT rooms_host_required CHECK (host_id IS NOT NULL),

  -- Enforce: closed rooms must have a closed_at timestamp.
  CONSTRAINT rooms_closed_at_consistency
    CHECK (
      (status != 'closed') OR (status = 'closed' AND closed_at IS NOT NULL)
    )
);

COMMENT ON TABLE public.rooms IS
  'Watch-together sync sessions. One room per watch event. Host-owned.';

COMMENT ON COLUMN public.rooms.settings IS
  'JSONB bag: content_id, max_participants, has_international_guests, sync_tolerance_ms, etc.';

COMMENT ON COLUMN public.rooms.playback_state IS
  'Server-authoritative playback position snapshot. Updated via LiveKit data messages.';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_rooms_updated_at
  BEFORE UPDATE ON public.rooms
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Enable Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

-- POLICY: Host can read their own rooms.
CREATE POLICY "rooms: host read own"
  ON public.rooms
  FOR SELECT
  USING (auth.uid() = host_id);

-- POLICY: Participants (guests) can read rooms they are in.
-- Sub-select into participants; avoids a JOIN in the policy itself.
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

-- POLICY: Only the host may create a room with themselves as host_id.
CREATE POLICY "rooms: host insert"
  ON public.rooms
  FOR INSERT
  WITH CHECK (auth.uid() = host_id);

-- POLICY: Only the host may update their own room (status, settings, invite token).
CREATE POLICY "rooms: host update"
  ON public.rooms
  FOR UPDATE
  USING (auth.uid() = host_id)
  WITH CHECK (auth.uid() = host_id);

-- POLICY: Deny direct DELETE from client — rooms are logically closed, not deleted.
CREATE POLICY "rooms: deny client delete"
  ON public.rooms
  FOR DELETE
  USING (FALSE);

COMMIT;
