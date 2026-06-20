-- =============================================================================
-- Migration: 00002_create_users.sql
-- Purpose  : Public user profile table that extends Supabase auth.users.
--            auth.users is Supabase-managed (UUID, email, provider).
--            This table stores application-level profile data with RLS.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TABLE: public.users
-- ---------------------------------------------------------------------------
CREATE TABLE public.users (
  -- Mirror the Supabase auth UID — not generated here, FK into auth.users.
  id                UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  email             TEXT        NOT NULL,

  -- The OAuth/SAML provider used at registration, or 'email' for OTP/passkey.
  auth_provider     TEXT        NOT NULL DEFAULT 'email'
                                CHECK (auth_provider IN ('email', 'google', 'apple', 'passkey')),

  subscription_tier public.subscription_tier NOT NULL DEFAULT 'free',

  -- Display name pulled from provider or set by user.
  display_name      TEXT,

  -- Avatar URL (provider CDN or Supabase Storage).
  avatar_url        TEXT,

  -- Stripe Customer ID — populated on first checkout session creation.
  stripe_customer_id TEXT UNIQUE,

  -- Razorpay Customer ID — populated on first INR checkout.
  razorpay_customer_id TEXT UNIQUE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_unique UNIQUE (email)
);

COMMENT ON TABLE public.users IS
  'Application user profiles. Extends auth.users. RLS enforces strict per-user isolation.';

-- ---------------------------------------------------------------------------
-- Auto-update updated_at on any row mutation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-provision a public.users row when a new auth.users record is created.
-- Triggered by Supabase Auth on every sign-up (email OTP, OAuth, passkey).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, auth_provider, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_app_meta_data->>'provider', 'email'),
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1)
    ),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Enable Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- POLICY: A user may read their own profile only.
CREATE POLICY "users: self read"
  ON public.users
  FOR SELECT
  USING (auth.uid() = id);

-- POLICY: A user may update their own profile only.
-- Note: subscription_tier, stripe_customer_id are only modified by
-- server-side webhook handlers (service_role key bypasses RLS).
CREATE POLICY "users: self update"
  ON public.users
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- POLICY: Deny direct INSERT from client — only the trigger creates rows.
-- service_role (webhook handlers) can still INSERT if needed.
CREATE POLICY "users: deny client insert"
  ON public.users
  FOR INSERT
  WITH CHECK (FALSE);

-- POLICY: Deny client DELETE — CASCADE from auth.users handles cleanup.
CREATE POLICY "users: deny client delete"
  ON public.users
  FOR DELETE
  USING (FALSE);

COMMIT;
