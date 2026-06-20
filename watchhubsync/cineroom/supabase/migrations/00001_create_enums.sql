-- =============================================================================
-- Migration: 00001_create_enums.sql
-- Purpose  : Establish all domain enum types before tables reference them.
--            Enums are immutable once used — add variants via ALTER TYPE.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- subscription_tier
-- free  : Can join rooms, cannot host (or host with hard limits).
-- premium: Paid host; metered billing applies beyond included minutes.
-- ---------------------------------------------------------------------------
CREATE TYPE public.subscription_tier AS ENUM (
  'free',
  'premium'
);

-- ---------------------------------------------------------------------------
-- platform
-- Enumerated OTT platforms supported by the sync engine.
-- Adding new platforms requires a new migration: ALTER TYPE ... ADD VALUE.
-- ---------------------------------------------------------------------------
CREATE TYPE public.platform AS ENUM (
  'youtube',
  'jiohotstar',
  'netflix',   -- Future: sync via extension adapter
  'primevideo' -- Future
);

-- ---------------------------------------------------------------------------
-- room_status
-- ---------------------------------------------------------------------------
CREATE TYPE public.room_status AS ENUM (
  'waiting',  -- Room created, host has not started playback
  'active',   -- At least one participant; sync ticks are live
  'closed'    -- Host ended room; billing finalized
);

-- ---------------------------------------------------------------------------
-- participant_role
-- ---------------------------------------------------------------------------
CREATE TYPE public.participant_role AS ENUM (
  'host',
  'guest'
);

-- ---------------------------------------------------------------------------
-- device_type
-- Tracks whether a participant is on the primary (video) device or
-- the secondary (mobile remote) device. Critical for dual-device moat.
-- ---------------------------------------------------------------------------
CREATE TYPE public.device_type AS ENUM (
  'primary',   -- Desktop / Smart TV: renders video
  'remote'     -- Mobile: sends reactions/chat, receives sync state
);

COMMIT;
