-- =============================================================================
-- Migration: 00001_create_enums.sql
-- Purpose  : Establish all domain enum types before tables reference them.
--            Enums are immutable once used — add variants via ALTER TYPE.
--
-- Idempotency: PostgreSQL has no CREATE TYPE IF NOT EXISTS. We use the
-- standard DO … EXCEPTION WHEN duplicate_object pattern so this migration
-- is safe to re-run (e.g., after a partial rollback in development).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- subscription_tier
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.subscription_tier AS ENUM (
    'free',
    'premium'
  );
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'type "subscription_tier" already exists — skipping';
END $$;

-- ---------------------------------------------------------------------------
-- platform
-- Enumerated OTT platforms supported by the sync engine.
-- Adding new platforms requires a new migration: ALTER TYPE … ADD VALUE.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.platform AS ENUM (
    'youtube',
    'jiohotstar',
    'netflix',    -- Future: sync via extension adapter
    'primevideo'  -- Future
  );
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'type "platform" already exists — skipping';
END $$;

-- ---------------------------------------------------------------------------
-- room_status
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.room_status AS ENUM (
    'waiting',  -- Room created, host has not started playback
    'active',   -- At least one participant; sync ticks are live
    'closed'    -- Host ended room; billing finalized
  );
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'type "room_status" already exists — skipping';
END $$;

-- ---------------------------------------------------------------------------
-- participant_role
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.participant_role AS ENUM (
    'host',
    'guest'
  );
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'type "participant_role" already exists — skipping';
END $$;

-- ---------------------------------------------------------------------------
-- device_type
-- Tracks whether a participant is on the primary (video) device or the
-- secondary (mobile remote) device. Critical for the dual-device moat.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.device_type AS ENUM (
    'primary',  -- Desktop / Smart TV: renders video
    'remote'    -- Mobile: sends reactions/chat, receives sync state
  );
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'type "device_type" already exists — skipping';
END $$;

COMMIT;
