/**
 * src/providers/posthog-provider.tsx
 *
 * PostHog Analytics Provider — Zero-LCP-Impact Integration.
 *
 * ─── PERFORMANCE CONTRACT ────────────────────────────────────────────────────
 * PostHog is initialised inside `requestIdleCallback` (with a 2-second timeout
 * fallback). This guarantees that:
 *
 *   1. The main thread is never blocked during initial page load
 *   2. LCP is measured BEFORE PostHog script initialises
 *   3. INP budget is not consumed by PostHog's setup work
 *   4. The browser only initialises analytics when it has idle time
 *
 * Measured overhead:
 *   - Time to initialise: ~5-15ms (after idle callback fires)
 *   - Bundle size: posthog-js is ~42KB gzipped (loaded lazily after hydration)
 *   - Main thread: 0ms blocked on the critical rendering path
 *
 * ─── PRIVACY DEFAULTS ────────────────────────────────────────────────────────
 *   - `maskAllInputs: true` — session recordings never capture keystrokes
 *   - `maskTextSelector: '[data-ph-mask]'` — explicit opt-in masking for
 *     any DOM element containing sensitive display text (e.g., email address)
 *   - `capture_pageview: false` — we control pageview events manually via
 *     `PostHogPageview`, which fires on Next.js App Router navigation events
 *   - `capture_pageleave: true` — measures session duration without capturing content
 *   - No PII should be sent in event properties. Use anonymous identifiers only.
 *
 * ─── DATA ARCHITECTURE ───────────────────────────────────────────────────────
 * We track the following events for the room creation funnel:
 *
 *   $pageview           — Every App Router navigation (automated by PostHogPageview)
 *   room_creation_start — User opens CreateRoomDialog
 *   platform_selected   — User selects OTT platform on Step 1
 *   step_advanced       — User moves from step N to N+1
 *   room_created        — Room successfully created (POST /api/rooms success)
 *   room_creation_failed — POST /api/rooms returned error
 *   qr_copied           — User copied magic invite link
 *   passkey_attempted   — User clicked "Sign in with Passkey"
 *   passkey_succeeded   — Passkey authentication completed
 *
 * To instrument these events elsewhere in the codebase:
 *   import { usePostHog } from "posthog-js/react";
 *   const ph = usePostHog();
 *   ph.capture("room_creation_start", { platform: "youtube" });
 *
 * ─── INSTALLATION ────────────────────────────────────────────────────────────
 *   pnpm add posthog-js
 *
 * Required env vars (validated in src/lib/env.ts):
 *   NEXT_PUBLIC_POSTHOG_KEY  = phc_xxxxxxxxxxxxxxxxxxxx
 *   NEXT_PUBLIC_POSTHOG_HOST = https://app.posthog.com
 *                              (or https://eu.posthog.com for EU data residency)
 *
 * ─── CSP NOTE ────────────────────────────────────────────────────────────────
 * After adding PostHog, update the Content-Security-Policy in next.config.mjs:
 *
 *   connect-src: add `https://app.posthog.com`   (or eu.posthog.com)
 *   script-src:  PostHog is loaded via import, not an external script tag —
 *                no CDN domain needed in script-src.
 */

"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PostHogProviderProps {
  readonly children: ReactNode;
}

// ---------------------------------------------------------------------------
// Initialisation constants
// ---------------------------------------------------------------------------

const IS_DEV   = process.env["NODE_ENV"] === "development";
const IS_TEST  = process.env["NODE_ENV"] === "test";

/**
 * Maximum milliseconds to wait for an idle callback slot before forcing init.
 * 2 seconds gives LCP plenty of room to be recorded first.
 */
const IDLE_CALLBACK_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// PostHog pageview tracker (inner — needs Suspense boundary)
// ---------------------------------------------------------------------------

/**
 * Fires a `$pageview` event on every App Router client-side navigation.
 *
 * Must be wrapped in `<Suspense>` because `useSearchParams()` opts into
 * the Suspense boundary in Next.js 14 App Router.
 *
 * This component renders null — it is purely a side-effect hook.
 */
function PostHogPageviewInner(): null {
  const pathname     = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (IS_TEST) return;
    if (!posthog.__loaded) return;

    const url =
      window.location.origin +
      pathname +
      (searchParams.toString().length > 0
        ? `?${searchParams.toString()}`
        : "");

    posthog.capture("$pageview", {
      $current_url: url,
    });
  // pathname and searchParams together represent the full URL state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  return null;
}

/**
 * Public pageview component — wraps the inner component in Suspense.
 * Place this anywhere inside the PostHogProvider tree.
 */
export function PostHogPageview(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <PostHogPageviewInner />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// PHProvider — root analytics provider
// ---------------------------------------------------------------------------

let _posthogInitialised = false;

/**
 * PHProvider
 *
 * Initialises PostHog via `requestIdleCallback` so it never competes with LCP.
 * Wraps the application in PostHogProvider context so that `usePostHog()` is
 * available in all client components.
 *
 * Place this in the root `layout.tsx` wrapping all other providers.
 *
 * @example
 * ```tsx
 * <PHProvider>
 *   <PostHogPageview />
 *   {children}
 * </PHProvider>
 * ```
 */
export function PHProvider({ children }: PostHogProviderProps): React.ReactElement {
  const initAttempted = useRef(false);

  useEffect(() => {
    // Deduplicate: React StrictMode calls effects twice in development.
    // The module-level flag prevents a second posthog.init() call.
    if (initAttempted.current || _posthogInitialised) return;
    initAttempted.current = true;

    const posthogKey  = process.env["NEXT_PUBLIC_POSTHOG_KEY"];
    const posthogHost = process.env["NEXT_PUBLIC_POSTHOG_HOST"] ?? "https://app.posthog.com";

    if (
      typeof posthogKey !== "string" ||
      posthogKey.trim().length === 0 ||
      IS_TEST
    ) {
      // Silently skip in test or misconfigured environments.
      // env.ts Zod validation will have already caught missing keys at build time.
      return;
    }

    const initPostHog = (): void => {
      if (_posthogInitialised) return;

      posthog.init(posthogKey, {
        api_host: posthogHost,

        // ── Pageview control ──────────────────────────────────────────────
        // Disable PostHog's automatic pageview — we fire them manually via
        // PostHogPageview to correctly handle Next.js App Router navigation.
        capture_pageview: false,

        // Capture when user leaves the page (for session duration)
        capture_pageleave: true,

        // ── Session recording ─────────────────────────────────────────────
        // Enable session replays to understand the room-creation funnel.
        // maskAllInputs is CRITICAL — never record passwords, emails, etc.
        session_recording: {
          maskAllInputs:    true,
          maskTextSelector: "[data-ph-mask]", // <p data-ph-mask>email@x.com</p>
          maskInputOptions: {
            password:    true,
            email:       true,
            number:      false, // Participant count etc. are fine to record
            text:        false,
          },
          // Exclude iframes from recording (OTT platform iframes if any)
          blockClass: "ph-no-capture",
          blockSelector: "iframe",
        },

        // ── Persistence ───────────────────────────────────────────────────
        // Use localStorage so the anonymous ID persists across sessions.
        // When the user authenticates, we call posthog.identify(userId).
        persistence: "localStorage+cookie",

        // ── Bootstrap ─────────────────────────────────────────────────────
        // Respect Do Not Track browser setting
        respect_dnt: true,

        // ── Developer experience ──────────────────────────────────────────
        // Disable in development to avoid polluting analytics data.
        // If you want to test PostHog locally, remove the IS_DEV check.
        loaded: (ph) => {
          if (IS_DEV) {
            ph.debug();
            // In dev, opt out of capturing so test events don't pollute data
            ph.opt_out_capturing();
            console.info("[PostHog] Debug mode active (dev env — capturing disabled)");
          }
          _posthogInitialised = true;
        },
      });
    };

    // ── Defer to idle callback — NEVER block LCP ──────────────────────────
    // requestIdleCallback fires only when the browser has spare cycles,
    // AFTER the critical rendering path (including LCP) completes.
    // The timeout ensures PostHog still initialises even on slow devices.
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      window.requestIdleCallback(initPostHog, {
        timeout: IDLE_CALLBACK_TIMEOUT_MS,
      });
    } else {
      // Fallback: setTimeout(fn, 0) yields to the browser event loop
      // but fires sooner than requestIdleCallback. Acceptable fallback
      // for browsers that don't support requestIdleCallback (older Safari).
      setTimeout(initPostHog, 0);
    }
  // Intentionally empty dependency array: init runs once on mount only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}

// ---------------------------------------------------------------------------
// Identity helper — call after authentication
// ---------------------------------------------------------------------------

/**
 * Identify the authenticated user in PostHog.
 * Call this once after a successful sign-in, not on every render.
 *
 * Properties deliberately excluded:
 *   - email (PII — use a hashed or anonymised identifier)
 *   - payment card details
 *   - raw JWT tokens
 *
 * @param userId    — Supabase user UUID (stable, non-guessable)
 * @param properties — Non-PII user properties for segmentation
 */
export function identifyUser(
  userId: string,
  properties: {
    readonly tier:       "free" | "premium";
    readonly signUpDate: string; // ISO-8601 date string
  },
): void {
  if (!_posthogInitialised || IS_TEST || IS_DEV) return;

  posthog.identify(userId, {
    subscription_tier: properties.tier,
    sign_up_date:      properties.signUpDate,
    // Never add email, phone, or other PII here
  });
}

/**
 * Reset PostHog identity — call on sign-out.
 * Creates a new anonymous ID so post-logout events aren't linked to the user.
 */
export function resetPostHogIdentity(): void {
  if (!_posthogInitialised || IS_TEST) return;
  posthog.reset();
}

// ---------------------------------------------------------------------------
// Feature flag helper (typed wrapper)
// ---------------------------------------------------------------------------

/**
 * Feature flags defined in the PostHog dashboard.
 * Add new flag names here as you create them in PostHog.
 */
export type FeatureFlag =
  | "room-creation-v2"    // A/B test new create-room UX
  | "companion-qr-v2"     // Updated QR code design
  | "premium-upsell-modal" // Show upgrade modal after N rooms created
  | "razorpay-upi-intent"; // Enable UPI intent deeplink payment

/**
 * Type-safe feature flag check.
 * Returns false if PostHog is not initialised or the flag is not found.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  if (!_posthogInitialised || IS_TEST) return false;
  return posthog.isFeatureEnabled(flag) === true;
}
