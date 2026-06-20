/**
 * src/lib/supabase/client.ts
 *
 * Browser-side Supabase client for WatchHubSync.
 *
 * Design decisions:
 *   1. Singleton pattern — a single SupabaseClient instance is reused across
 *      the React component tree to prevent multiple GoTrue auth listeners
 *      and avoid redundant cookie synchronization overhead.
 *
 *   2. `createBrowserClient` from `@supabase/ssr` handles the cookie layer
 *      automatically, keeping the auth token synchronized between the browser
 *      and server without manual token passing.
 *
 *   3. This module is intentionally free of React hooks — it exports the raw
 *      client. Hook abstractions (`useSession`, `useUser`) live in
 *      `src/hooks/use-session.ts` and use this client internally.
 *
 *   4. The anon key is safe to expose to the browser. RLS policies in the
 *      database enforce data access boundaries — the anon key alone grants
 *      no privileged access.
 *
 * Usage:
 *   import { getSupabaseBrowserClient } from '@/lib/supabase/client'
 *   const supabase = getSupabaseBrowserClient()
 *   const { data } = await supabase.from('rooms').select('*')
 */

"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TypedSupabaseClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let browserClientInstance: TypedSupabaseClient | undefined;

/**
 * Returns the singleton Supabase browser client.
 *
 * Creating a new client per render cycle would spawn multiple GoTrue
 * auth state listeners, causing memory leaks and duplicate session events.
 * This factory pattern guarantees exactly one instance per browser session.
 *
 * Safe to call multiple times — subsequent calls return the same instance.
 */
export function getSupabaseBrowserClient(): TypedSupabaseClient {
  if (browserClientInstance !== undefined) {
    return browserClientInstance;
  }

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const supabaseAnonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  if (!supabaseUrl) {
    throw new Error(
      "[WatchHubSync] NEXT_PUBLIC_SUPABASE_URL is not defined. " +
        "Set it in .env.local.",
    );
  }

  if (!supabaseAnonKey) {
    throw new Error(
      "[WatchHubSync] NEXT_PUBLIC_SUPABASE_ANON_KEY is not defined. " +
        "Set it in .env.local.",
    );
  }

  browserClientInstance = createBrowserClient<Database>(
    supabaseUrl,
    supabaseAnonKey,
    {
      auth: {
        // Persist the session in localStorage so users remain signed in
        // across browser tabs and restarts.
        persistSession: true,
        // Automatically refresh the access token before it expires.
        autoRefreshToken: true,
        // Detect the auth code/token from the URL after OAuth redirects.
        detectSessionInUrl: true,
        // Use PKCE flow — more secure than the implicit flow for SPAs.
        flowType: "pkce",
      },
      global: {
        headers: {
          "x-client-name": "watchhubsync-web",
          "x-client-version": process.env["NEXT_PUBLIC_APP_VERSION"] ?? "0.1.0",
        },
      },
    },
  );

  return browserClientInstance;
}

/**
 * Reset the singleton. Call this ONLY in test environments to get a
 * clean client between test cases. Never call in production code.
 *
 * @internal
 */
export function _resetSupabaseBrowserClientForTests(): void {
  browserClientInstance = undefined;
}
