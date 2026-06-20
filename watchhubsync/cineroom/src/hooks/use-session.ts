/**
 * src/hooks/use-session.ts
 *
 * React hook that subscribes to the Supabase auth state and returns
 * the current session, user, and loading state.
 *
 * Design guarantees:
 *   - Single GoTrue listener per React tree (the browser client is a singleton).
 *   - Calls getSession() once on mount to hydrate from cookies/localStorage,
 *     then stays in sync via onAuthStateChange.
 *   - isLoading is TRUE only during initial hydration — never between
 *     subsequent auth state transitions.
 *
 * Usage:
 *   const { user, session, isLoading } = useSession()
 */

"use client";

import { useState, useEffect, useRef } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionState {
  /** null during initial load; null after load if unauthenticated */
  readonly session: Session | null;
  /** Convenience alias for session?.user */
  readonly user: User | null;
  /** True only during the initial cookie-to-session hydration */
  readonly isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    session: null,
    user: null,
    isLoading: true,
  });

  // Track whether the component has unmounted to prevent setState on cleanup.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    const supabase = getSupabaseBrowserClient();

    // ── Initial hydration ─────────────────────────────────────────────────
    // getSession() reads from the local cookie/storage — no network call.
    // This resolves synchronously in most cases but is async per the API.
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (!isMountedRef.current) return;
        setState({
          session,
          user: session?.user ?? null,
          isLoading: false,
        });
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        // Session read failed (e.g., malformed cookie) — treat as signed out.
        setState({ session: null, user: null, isLoading: false });
      });

    // ── Reactive subscription ─────────────────────────────────────────────
    // onAuthStateChange fires on: SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED,
    // PASSWORD_RECOVERY, USER_UPDATED, MFA_CHALLENGE_VERIFIED.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMountedRef.current) return;
      setState({
        session,
        user: session?.user ?? null,
        isLoading: false,
      });
    });

    return () => {
      isMountedRef.current = false;
      subscription.unsubscribe();
    };
  }, []);

  return state;
}

// ---------------------------------------------------------------------------
// Derived hook — returns only the user (avoids spread in simple components)
// ---------------------------------------------------------------------------

export function useUser(): User | null {
  const { user } = useSession();
  return user;
}
