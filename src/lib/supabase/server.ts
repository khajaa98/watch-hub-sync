/**
 * src/lib/supabase/server.ts
 *
 * Server-side Supabase client factories for WatchHubSync.
 *
 * Three distinct factory functions for three distinct contexts:
 *
 *   createSupabaseServerComponentClient()
 *     → Use in React Server Components (RSC).
 *       Cookie writes are no-ops (RSCs are read-only). The middleware
 *       is responsible for keeping the session alive via setAll.
 *
 *   createSupabaseRouteHandlerClient()
 *     → Use in Route Handlers (/api/**) and Server Actions.
 *       Full cookie read/write access. Required for any mutation
 *       that must refresh the Supabase session token.
 *
 *   createSupabaseServiceClient()
 *     → Service-role key. Bypasses ALL Row Level Security.
 *       Use exclusively in trusted server-side contexts:
 *       webhook handlers, cron jobs, admin operations.
 *       NEVER expose to the browser or pass to client components.
 *
 * All clients are typed against the Database generic from supabase.ts.
 * This prevents raw string queries from leaking unchecked JSON.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Environment validation
// Fail fast at module load rather than at runtime inside a request handler.
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[WatchHubSync] Missing required environment variable: "${key}". ` +
        `Check .env.local against .env.example.`,
    );
  }
  return value;
}

const SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_ANON_KEY = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

// Service key is only required on the server. We defer its validation to
// the factory call so edge bundles (middleware) don't fail on import.
function getServiceRoleKey(): string {
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

// ---------------------------------------------------------------------------
// Factory: Server Components (read-only cookie access)
// ---------------------------------------------------------------------------

/**
 * Returns a typed Supabase client scoped to the current RSC request.
 *
 * Calls to `setAll` are deliberately silenced — in an RSC context the
 * response headers are already sent and cookies cannot be mutated.
 * The Next.js middleware (`src/middleware.ts`) refreshes the session
 * before the RSC renders, so stale tokens are not a concern here.
 *
 * @example
 * // In a Server Component:
 * const supabase = createSupabaseServerComponentClient()
 * const { data: { user } } = await supabase.auth.getUser()
 */
export function createSupabaseServerComponentClient() {
  const cookieStore = cookies();

  return createServerClient<Database, "public">(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(_cookiesToSet) {
        // Intentionally a no-op in RSC context.
        // Session refresh is handled by src/middleware.ts.
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Factory: Route Handlers & Server Actions (full cookie access)
// ---------------------------------------------------------------------------

/**
 * Returns a typed Supabase client that can both read and write cookies.
 *
 * Use this in:
 *   - /api/** Route Handlers
 *   - `"use server"` Server Actions
 *   - Supabase Auth callback route (/auth/callback/route.ts)
 *
 * @example
 * // In a Route Handler:
 * export async function GET() {
 *   const supabase = createSupabaseRouteHandlerClient()
 *   const { data: { session } } = await supabase.auth.getSession()
 * }
 */
export function createSupabaseRouteHandlerClient() {
  const cookieStore = cookies();

  return createServerClient<Database, "public">(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(
          ({
            name,
            value,
            options,
          }: {
            name: string;
            value: string;
            options: CookieOptions;
          }) => {
            cookieStore.set(name, value, options);
          },
        );
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Factory: Service Role (RLS bypass — server-only)
// ---------------------------------------------------------------------------

/**
 * Returns a Supabase client authenticated with the service_role key.
 *
 * ⚠️  SECURITY CONTRACT:
 *   - ONLY call this from:
 *     - Webhook handlers (LiveKit, Stripe, Razorpay, Svix)
 *     - Cron / background jobs
 *     - Admin-gated server actions
 *   - NEVER import this in Client Components, page.tsx files, or
 *     any module that could be bundled into the browser chunk.
 *   - autoRefreshToken and persistSession are both disabled;
 *     the service key is stateless and must not persist.
 *
 * @example
 * // In a webhook handler:
 * const supabase = createSupabaseServiceClient()
 * await supabase.from('billing_meters').insert({ ... })
 */
export function createSupabaseServiceClient() {
  return createClient<Database, "public">(SUPABASE_URL, getServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Utility: Require authenticated user from a Route Handler context.
// Throws a structured error if the session is absent or expired.
// ---------------------------------------------------------------------------

export class AuthRequiredError extends Error {
  readonly statusCode = 401;
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/**
 * Extract the authenticated user from the current route handler request.
 * Calls `getUser()` (network-verified) rather than `getSession()` (local-only).
 *
 * `getUser()` makes a request to the Supabase Auth server to validate the
 * access token, making it immune to tampered JWTs. Use it anywhere you need
 * a server-authoritative identity check.
 *
 * @throws {AuthRequiredError} if no authenticated session exists.
 */
export async function requireUser() {
  const supabase = createSupabaseRouteHandlerClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error !== null || user === null) {
    throw new AuthRequiredError();
  }

  return user;
}
