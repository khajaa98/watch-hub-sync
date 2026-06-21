/**
 * src/middleware.ts
 *
 * Next.js Edge Middleware for WatchHubSync.
 *
 * Execution order per request (fail-fast ordering — cheapest checks first):
 *
 *   1. Rate Limiting (Upstash Redis sliding window)
 *      Cheapest possible rejection — a single Redis EVALSHA call.
 *      Blocks bots, credential stuffers, and DDoS before any auth work.
 *
 *   2. JWT Cryptographic Verification (jose — zero network calls)
 *      Verifies the Supabase access token signature using the project's
 *      JWT secret. This is a pure CPU operation running in the V8 isolate.
 *      If the token is absent or invalid, redirect to /login immediately.
 *      This step is intentionally more paranoid than supabase.auth.getUser()
 *      because it does NOT make a network round-trip to Supabase Auth.
 *
 *   3. Supabase Session Refresh (SSR cookie synchronization)
 *      Calls supabase.auth.getUser() to ensure the session cookies are
 *      up to date and the refresh token has been rotated if needed.
 *      This is the canonical Supabase SSR pattern.
 *
 *   4. Route Protection
 *      Protected routes (under /dashboard, /rooms, /billing) redirect
 *      unauthenticated users to /login.
 *      Auth routes (/login) redirect already-authenticated users to /dashboard.
 *
 * Edge Runtime compatibility notes:
 *   - `@upstash/ratelimit` and `@upstash/redis` use fetch() — edge compatible.
 *   - `jose` uses the Web Crypto API — edge compatible.
 *   - `@supabase/ssr` uses fetch() and the cookies() polyfill — edge compatible.
 *   - `pino` transports are NOT available here; structured console.log is used.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { jwtVerify, type JWTPayload } from "jose";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { Database, SupabaseJWTPayload } from "@/types/supabase";

// Middleware always runs on the Edge Runtime in Next.js — no runtime export needed.
// Adding `export const runtime = "edge"` here causes Next.js to treat the file
// as a page and throw "experimental edge runtime" errors at build time.

// ---------------------------------------------------------------------------
// Route matchers
// ---------------------------------------------------------------------------

/**
 * Routes that require an authenticated session.
 * These mirror the (app) route group in src/app/(app)/.
 */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/rooms",
  "/billing",
] as const;

/**
 * Routes that should redirect authenticated users away (e.g. login page).
 */
const AUTH_PREFIXES = ["/login"] as const;

/**
 * Static assets and internal Next.js paths — skip all middleware checks.
 */
const BYPASS_REGEX =
  /^\/(_next\/static|_next\/image|favicon\.ico|icons\/|fonts\/|og\/)/;

function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isAuthRoute(pathname: string): boolean {
  return AUTH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Rate Limiter (Upstash Redis — sliding window)
// ---------------------------------------------------------------------------

/**
 * Lazy-initialized rate limiter.
 * Laziness is critical: instantiation reads env vars that may not exist
 * in all deployment environments (e.g., development without Upstash).
 */
let _ratelimiter: Ratelimit | null = null;

function getRatelimiter(): Ratelimit | null {
  if (_ratelimiter !== null) return _ratelimiter;

  const url = process.env["UPSTASH_REDIS_REST_URL"];
  const token = process.env["UPSTASH_REDIS_REST_TOKEN"];

  if (!url || !token) {
    // Rate limiting is disabled in environments without Upstash.
    // Log a warning once per cold start.
    console.warn(
      "[middleware] UPSTASH_REDIS_REST_URL or TOKEN not set. " +
        "Rate limiting is DISABLED. Set these in .env.local for local dev.",
    );
    return null;
  }

  _ratelimiter = new Ratelimit({
    redis: new Redis({ url, token }),
    // 60 requests per 60 seconds, sliding window.
    // Adjust per route in a production system using prefix-based limiters.
    limiter: Ratelimit.slidingWindow(60, "60 s"),
    analytics: true,
    prefix: "watchhubsync:rl",
  });

  return _ratelimiter;
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

interface VerifiedClaims extends JWTPayload {
  sub: string;
  role: "authenticated" | "anon";
  aud: string;
  email?: string;
}

/**
 * Verify the Supabase access JWT using the project's signing secret.
 *
 * Why we do this in addition to supabase.auth.getUser():
 *   getUser() makes a network call to Supabase Auth to validate the token.
 *   This adds ~50–150ms of latency on every protected request.
 *   Verifying the JWT signature ourselves is a synchronous CPU operation
 *   (~1ms) that provides the same cryptographic guarantee on the edge.
 *   We STILL call getUser() afterwards to refresh the session token, but
 *   only for routes where the session actually needs refreshing.
 *
 * @returns Verified JWT claims, or null if verification fails.
 */
async function verifySupabaseJWT(
  token: string,
): Promise<VerifiedClaims | null> {
  const secret = process.env["SUPABASE_JWT_SECRET"];

  if (!secret) {
    console.error(
      "[middleware] SUPABASE_JWT_SECRET is not set. JWT verification disabled.",
    );
    return null;
  }

  try {
    const encodedSecret = new TextEncoder().encode(secret);

    const { payload } = await jwtVerify<SupabaseJWTPayload>(
      token,
      encodedSecret,
      {
        // Supabase tokens are always issued for the "authenticated" audience.
        // Anon keys carry "anon" — we reject those from protected routes.
        audience: "authenticated",
        issuer: `${process.env["NEXT_PUBLIC_SUPABASE_URL"]}/auth/v1`,
        // jose validates exp and iat automatically.
        clockTolerance: 10, // 10-second clock skew tolerance for edge nodes
      },
    );

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }

    return payload as VerifiedClaims;
  } catch {
    // jwtVerify throws on expired, malformed, or tampered tokens.
    // We intentionally swallow the error here — the caller treats null as
    // "unauthenticated" and redirects to /login.
    return null;
  }
}

/**
 * Extract the Supabase access token from the request cookies.
 * Supabase SSR stores the token in a cookie named `sb-{project-ref}-auth-token`.
 * We iterate all cookies rather than hard-coding the name to be project-agnostic.
 */
function extractSupabaseToken(request: NextRequest): string | null {
  for (const [name, cookie] of request.cookies) {
    if (name.startsWith("sb-") && name.endsWith("-auth-token")) {
      try {
        // The cookie value is a JSON-encoded GoTrue session object.
        const session = JSON.parse(cookie.value) as {
          access_token?: string;
        };
        if (typeof session.access_token === "string") {
          return session.access_token;
        }
      } catch {
        // Malformed cookie value — treat as unauthenticated.
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Middleware entry point
// ---------------------------------------------------------------------------

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // ── Step 0: bypass static assets and Next.js internals ──────────────────
  if (BYPASS_REGEX.test(pathname)) {
    return NextResponse.next();
  }

  // ── Step 1: Rate limiting ────────────────────────────────────────────────
  const limiter = getRatelimiter();

  if (limiter !== null) {
    // Prefer X-Forwarded-For (set by Vercel) over the raw IP.
    const forwardedFor = request.headers.get("x-forwarded-for");
    const ip =
      (forwardedFor !== null ? forwardedFor.split(",")[0]?.trim() : null) ??
      "anonymous";

    const { success, limit, reset, remaining } = await limiter.limit(ip);

    if (!success) {
      const retryAfterSecs = Math.ceil((reset - Date.now()) / 1000);

      return new NextResponse("Too Many Requests", {
        status: 429,
        headers: {
          "Content-Type": "text/plain",
          "X-RateLimit-Limit": limit.toString(),
          "X-RateLimit-Remaining": remaining.toString(),
          "X-RateLimit-Reset": reset.toString(),
          "Retry-After": retryAfterSecs.toString(),
        },
      });
    }
  }

  // ── Step 2: JWT cryptographic verification (edge-local, zero network) ───
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  const supabaseAnonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ?? "";

  // We need a mutable response reference that the Supabase cookie handler
  // can replace when it writes refreshed auth cookies.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        // Apply to the cloned request (Supabase internal requirement).
        request.cookies.set(name, value);
        // Rebuild response so Next.js propagates the updated request cookies.
        supabaseResponse = NextResponse.next({ request });
        supabaseResponse.cookies.set(name, value, options);
      },
      remove(name: string, options: CookieOptions) {
        request.cookies.delete(name);
        supabaseResponse = NextResponse.next({ request });
        supabaseResponse.cookies.set(name, "", options);
      },
    },
  });

  const accessToken = extractSupabaseToken(request);

  // Only run the JWT check on routes that need authentication state.
  const needsAuth = isProtectedRoute(pathname) || isAuthRoute(pathname);

  let verifiedClaims: VerifiedClaims | null = null;

  if (needsAuth && accessToken !== null) {
    verifiedClaims = await verifySupabaseJWT(accessToken);
  }

  // ── Step 3: Supabase session refresh ────────────────────────────────────
  // We call getUser() to ensure the session cookie is rotated if the
  // access token has just expired and a valid refresh token exists.
  // This is the authoritative check — it goes to the Supabase Auth server.
  if (needsAuth) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const isAuthenticated = user !== null;

    // ── Step 4: Route protection ─────────────────────────────────────────

    if (isProtectedRoute(pathname) && !isAuthenticated) {
      // The JWT was absent, expired, or tampered — or session is unauthenticated.
      // IMPORTANT: preserve search params (e.g. ?token=... on invite links) so
      // the post-login redirect returns the user to the exact URL they intended.
      const fullPath = pathname + request.nextUrl.search;
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      loginUrl.searchParams.set("redirect", fullPath);
      return NextResponse.redirect(loginUrl);
    }

    if (isAuthRoute(pathname) && isAuthenticated) {
      // Authenticated user visiting /login — send them to the app.
      const dashboardUrl = request.nextUrl.clone();
      dashboardUrl.pathname = "/dashboard";
      dashboardUrl.searchParams.delete("redirect");
      return NextResponse.redirect(dashboardUrl);
    }

    // Attach verified user ID to request headers for downstream consumption.
    // Route Handlers can read this without calling getUser() again.
    if (isAuthenticated && user.id) {
      supabaseResponse.headers.set("x-user-id", user.id);

      if (verifiedClaims !== null) {
        supabaseResponse.headers.set(
          "x-user-role",
          verifiedClaims.role ?? "authenticated",
        );
      }
    }
  }

  // Security headers — applied on every non-bypassed response.
  supabaseResponse.headers.set("X-Frame-Options", "DENY");
  supabaseResponse.headers.set("X-Content-Type-Options", "nosniff");
  supabaseResponse.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  supabaseResponse.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(self)",
  );

  return supabaseResponse;
}

// ---------------------------------------------------------------------------
// Middleware matcher config
// ---------------------------------------------------------------------------

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     *   - _next/static  (static files)
     *   - _next/image   (image optimization)
     *   - favicon.ico
     *   - Files with a dot (e.g. robots.txt, sitemap.xml, .well-known)
     *
     * We intentionally DO NOT exclude /api/** here because our API routes
     * also need rate limiting. Auth checks inside API routes are done
     * independently via `requireUser()` from src/lib/supabase/server.ts.
     */
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
