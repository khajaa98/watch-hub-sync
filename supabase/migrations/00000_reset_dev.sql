-- =============================================================================
-- 00000_reset_dev.sql
--
-- DEVELOPMENT RESET — wipes all WHS schema objects so migrations can be
-- re-run from scratch cleanly.
--
-- !! NEVER RUN THIS IN PRODUCTION !!
--
-- Safe to run multiple times (all statements are IF EXISTS).
-- Run this in Supabase SQL Editor BEFORE re-running 00001 → 00006.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drop triggers that reference our functions FIRST (before the functions)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_billing_meter_immutable       ON public.billing_meters;
DROP TRIGGER IF EXISTS trg_participants_immutable_left   ON public.participants;
DROP TRIGGER IF EXISTS trg_rooms_updated_at              ON public.rooms;
DROP TRIGGER IF EXISTS trg_users_updated_at              ON public.users;
DROP TRIGGER IF EXISTS trg_on_auth_user_created          ON auth.users;

-- ---------------------------------------------------------------------------
-- 2. Drop tables in reverse FK dependency order
--    billing_meters → participants → rooms → users
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS public.billing_meters  CASCADE;
DROP TABLE IF EXISTS public.participants    CASCADE;
DROP TABLE IF EXISTS public.rooms           CASCADE;
DROP TABLE IF EXISTS public.users           CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Drop functions
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.enforce_billing_meter_immutability() CASCADE;
DROP FUNCTION IF EXISTS public.enforce_participant_left_at()        CASCADE;
DROP FUNCTION IF EXISTS public.handle_new_auth_user()               CASCADE;
DROP FUNCTION IF EXISTS public.set_updated_at()                     CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Drop enum types (CASCADE handles any residual dependencies)
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS public.device_type        CASCADE;
DROP TYPE IF EXISTS public.participant_role   CASCADE;
DROP TYPE IF EXISTS public.room_status        CASCADE;
DROP TYPE IF EXISTS public.platform           CASCADE;
DROP TYPE IF EXISTS public.subscription_tier  CASCADE;

COMMIT;
