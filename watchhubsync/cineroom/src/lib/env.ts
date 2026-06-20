/**
 * src/lib/env.ts
 *
 * Build-Time Environment Variable Validation.
 *
 * ─── FAIL-FAST GUARANTEE ─────────────────────────────────────────────────────
 * This module is imported at the top of `next.config.mjs`. If any required
 * variable is absent or malformed, the Zod parse throws a formatted error and
 * the `next build` process exits with a non-zero code. A misconfigured build
 * NEVER reaches Vercel's production edge.
 *
 * ─── TWO-SCHEMA ARCHITECTURE ─────────────────────────────────────────────────
 * Env vars are split across two schemas:
 *
 *   serverEnvSchema  — Node.js runtime only (API routes, webhooks, billing).
 *                      Never exposed to the browser or Edge middleware.
 *
 *   edgeEnvSchema    — Available in Edge middleware AND Node.js.
 *                      Contains only vars needed for JWT verification and
 *                      rate limiting at the Edge layer.
 *
 *   publicEnvSchema  — NEXT_PUBLIC_* vars that ship to the browser bundle.
 *                      Validated here so a missing public var fails build,
 *                      not runtime.
 *
 * ─── SUPAVISOR CONNECTION POOLING ────────────────────────────────────────────
 * Serverless functions use DATABASE_URL (Supavisor Transaction mode).
 * Long-running operations (migrations, webhook ingestion) use DATABASE_URL_DIRECT.
 *
 *   DATABASE_URL         → pooler.supabase.com:6543   (Supavisor — short queries)
 *   DATABASE_URL_DIRECT  → db.*.supabase.com:5432     (Direct — migrations/LISTEN)
 *
 * Supavisor Transaction mode limitations (document these):
 *   ✗ No prepared statements across connections
 *   ✗ No SET LOCAL that must persist
 *   ✗ No LISTEN/NOTIFY (use direct connection)
 *   ✓ Everything else: SELECT, INSERT, UPDATE, DELETE, transactions
 *
 * ─── SKIP PATTERN ────────────────────────────────────────────────────────────
 * Set SKIP_ENV_VALIDATION=1 to bypass validation in CI build steps that use
 * stub env vars. NEVER set this in production.
 *
 * Usage:
 *   import { serverEnv, edgeEnv, publicEnv } from "@/lib/env";
 *   const url = serverEnv.DATABASE_URL;
 */

import { z, type ZodError } from "zod";

// ---------------------------------------------------------------------------
// Custom refinements
// ---------------------------------------------------------------------------

/**
 * Validates a URL string. Accepts http and https only.
 * Custom message shown in build output when URL is malformed.
 */
const urlSchema = (label: string) =>
  z
    .string({ required_error: `${label}: required` })
    .url({ message: `${label}: must be a valid URL (https://...)` });

/**
 * Non-empty string with a minimum length guard and a label for error messages.
 */
const secretSchema = (label: string, minLength = 1) =>
  z
    .string({ required_error: `${label}: required` })
    .min(minLength, { message: `${label}: must be at least ${minLength} chars` });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * SERVER-ONLY environment variables.
 * Import from this schema only inside API routes, webhooks, and server actions.
 * Never reference these in client components, pages, or Edge middleware.
 */
const serverEnvSchema = z.object({
  // ── Node.js ──────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // ── Supabase (server) ─────────────────────────────────────────────────────
  SUPABASE_SERVICE_ROLE_KEY: secretSchema("SUPABASE_SERVICE_ROLE_KEY", 32),

  /**
   * Supavisor Transaction pooler — for all short-lived API route queries.
   * Format: postgres://[user].[project-ref]:[password]@[region].pooler.supabase.com:6543/postgres
   */
  DATABASE_URL: urlSchema("DATABASE_URL").refine(
    (v) => v.startsWith("postgres") || v.startsWith("postgresql"),
    "DATABASE_URL must be a PostgreSQL connection string",
  ),

  /**
   * Direct Postgres connection — for webhooks, migrations, and LISTEN/NOTIFY.
   * Format: postgresql://postgres:[password]@db.[project-ref].supabase.com:5432/postgres
   */
  DATABASE_URL_DIRECT: urlSchema("DATABASE_URL_DIRECT").refine(
    (v) => v.startsWith("postgres") || v.startsWith("postgresql"),
    "DATABASE_URL_DIRECT must be a PostgreSQL connection string",
  ),

  // ── LiveKit ───────────────────────────────────────────────────────────────
  LIVEKIT_API_KEY: secretSchema("LIVEKIT_API_KEY"),
  LIVEKIT_API_SECRET: secretSchema("LIVEKIT_API_SECRET", 32),
  LIVEKIT_URL: urlSchema("LIVEKIT_URL").refine(
    (v) => v.startsWith("wss://") || v.startsWith("ws://") || v.startsWith("https://"),
    "LIVEKIT_URL must be a WebSocket or HTTPS URL",
  ),

  // ── Stripe ────────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: z
    .string({ required_error: "STRIPE_SECRET_KEY: required" })
    .regex(
      /^sk_(live|test)_[A-Za-z0-9]+$/,
      "STRIPE_SECRET_KEY must start with sk_live_ or sk_test_",
    ),

  STRIPE_WEBHOOK_SECRET: z
    .string({ required_error: "STRIPE_WEBHOOK_SECRET: required" })
    .regex(
      /^whsec_/,
      "STRIPE_WEBHOOK_SECRET must start with whsec_",
    ),

  STRIPE_PRICE_ID_PREMIUM: z
    .string({ required_error: "STRIPE_PRICE_ID_PREMIUM: required" })
    .regex(
      /^price_/,
      "STRIPE_PRICE_ID_PREMIUM must start with price_",
    ),

  STRIPE_METER_ID_PARTICIPANT_MINUTES: secretSchema(
    "STRIPE_METER_ID_PARTICIPANT_MINUTES",
  ),

  // ── Razorpay ──────────────────────────────────────────────────────────────
  RAZORPAY_KEY_ID: z
    .string({ required_error: "RAZORPAY_KEY_ID: required" })
    .regex(
      /^rzp_(live|test)_/,
      "RAZORPAY_KEY_ID must start with rzp_live_ or rzp_test_",
    ),

  RAZORPAY_KEY_SECRET: secretSchema("RAZORPAY_KEY_SECRET", 16),

  RAZORPAY_WEBHOOK_SECRET: secretSchema("RAZORPAY_WEBHOOK_SECRET", 16),

  RAZORPAY_PLAN_ID_PREMIUM: z
    .string({ required_error: "RAZORPAY_PLAN_ID_PREMIUM: required" })
    .min(1),

  // ── Svix (auth webhook) ───────────────────────────────────────────────────
  SVIX_WEBHOOK_SECRET: z
    .string({ required_error: "SVIX_WEBHOOK_SECRET: required" })
    .regex(
      /^whsec_/,
      "SVIX_WEBHOOK_SECRET must start with whsec_",
    ),

  // ── Iron Session ─────────────────────────────────────────────────────────
  IRON_SESSION_SECRET: secretSchema("IRON_SESSION_SECRET", 32),

  // ── Observability ─────────────────────────────────────────────────────────
  /** Axiom API token for log ingestion. Optional: falls back to console in dev. */
  AXIOM_TOKEN: z
    .string()
    .startsWith("xaat-", "AXIOM_TOKEN must start with xaat-")
    .optional(),

  AXIOM_DATASET: z.string().optional(),
});

/**
 * EDGE-COMPATIBLE environment variables.
 * Safe to use in Next.js Middleware (Edge Runtime).
 * These vars are also available in Node.js server routes.
 */
const edgeEnvSchema = z.object({
  // Required in middleware for JWT verification
  SUPABASE_JWT_SECRET: secretSchema("SUPABASE_JWT_SECRET", 32),

  // Upstash Redis for rate limiting at Edge
  UPSTASH_REDIS_REST_URL: urlSchema("UPSTASH_REDIS_REST_URL").optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // App base URL — used for absolute URL construction in middleware
  NEXT_PUBLIC_APP_URL: urlSchema("NEXT_PUBLIC_APP_URL"),
});

/**
 * PUBLIC (browser-safe) environment variables.
 * Validated here so a missing NEXT_PUBLIC_* var fails at build time,
 * not silently at runtime in the browser.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: urlSchema("NEXT_PUBLIC_SUPABASE_URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: secretSchema(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    32,
  ),
  NEXT_PUBLIC_APP_URL: urlSchema("NEXT_PUBLIC_APP_URL"),
  NEXT_PUBLIC_LIVEKIT_URL: urlSchema("NEXT_PUBLIC_LIVEKIT_URL").optional(),

  // ── PostHog Analytics ─────────────────────────────────────────────────────
  /**
   * PostHog Project API Key.
   * Obtain from: PostHog Dashboard → Project Settings → Project API Key.
   * All PostHog project keys start with "phc_".
   * This is safe to expose in the browser — it is a write-only ingest key,
   * not a secret key. PostHog's personal API keys (used for admin operations)
   * are separate and must NEVER be placed here.
   */
  NEXT_PUBLIC_POSTHOG_KEY: z
    .string({ required_error: "NEXT_PUBLIC_POSTHOG_KEY: required" })
    .startsWith("phc_", "NEXT_PUBLIC_POSTHOG_KEY must start with phc_")
    .min(20, "NEXT_PUBLIC_POSTHOG_KEY appears too short — check your PostHog project settings"),

  /**
   * PostHog host URL.
   * US Cloud:  https://app.posthog.com  (default)
   * EU Cloud:  https://eu.posthog.com
   * Self-hosted: https://your-posthog-instance.example.com
   *
   * For Indian users, the US cloud (app.posthog.com) has acceptable latency
   * since PostHog events are fire-and-forget and do not block the UI.
   * Default: "https://app.posthog.com"
   */
  NEXT_PUBLIC_POSTHOG_HOST: urlSchema("NEXT_PUBLIC_POSTHOG_HOST")
    .default("https://app.posthog.com"),
});

// ---------------------------------------------------------------------------
// Validation runner
// ---------------------------------------------------------------------------

function formatZodError(error: ZodError, schemaName: string): string {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `  ✗  ${path}: ${issue.message}`;
    })
    .join("\n");

  return (
    `\n` +
    `╔══════════════════════════════════════════════════════════════╗\n` +
    `║     WATCH HUB SYNC — ENVIRONMENT VALIDATION FAILED          ║\n` +
    `║     Schema: ${schemaName.padEnd(49)}║\n` +
    `╚══════════════════════════════════════════════════════════════╝\n` +
    `\n` +
    `Missing or malformed environment variables:\n` +
    `\n` +
    issues +
    `\n\n` +
    `Ensure all required vars are set in:\n` +
    `  • .env.local       (local development)\n` +
    `  • Vercel Dashboard → Settings → Environment Variables (production)\n` +
    `\n` +
    `See INFRASTRUCTURE.md for the complete variable reference.\n`
  );
}

function validateEnv<T>(
  schema: z.ZodSchema<T>,
  input: Record<string, string | undefined>,
  schemaName: string,
): T {
  if (process.env["SKIP_ENV_VALIDATION"] === "1") {
    // CI stub mode — return raw input cast as T.
    // NEVER set SKIP_ENV_VALIDATION in production.
    return input as unknown as T;
  }

  const result = schema.safeParse(input);

  if (!result.success) {
    console.error(formatZodError(result.error, schemaName));
    // process.exit(1) in build context; throw in test context
    if (typeof process !== "undefined" && process.env["NODE_ENV"] !== "test") {
      process.exit(1);
    }
    throw new Error(
      `Environment validation failed for schema: ${schemaName}`,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Parsed and validated singletons
// ---------------------------------------------------------------------------

/**
 * Server-only validated environment.
 * Import this in API routes, webhooks, and server actions.
 *
 * @throws {Error} During `next build` if any required var is missing/malformed
 */
export const serverEnv = validateEnv(
  serverEnvSchema,
  process.env as Record<string, string | undefined>,
  "serverEnvSchema",
);

/**
 * Edge + Node.js validated environment.
 * Import this in `src/middleware.ts` and any Edge-runtime routes.
 */
export const edgeEnv = validateEnv(
  edgeEnvSchema,
  process.env as Record<string, string | undefined>,
  "edgeEnvSchema",
);

/**
 * Public (browser-safe) validated environment.
 * Import in Client Components to get type-safe NEXT_PUBLIC_* values.
 */
export const publicEnv = validateEnv(
  publicEnvSchema,
  process.env as Record<string, string | undefined>,
  "publicEnvSchema",
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type EdgeEnv   = z.infer<typeof edgeEnvSchema>;
export type PublicEnv = z.infer<typeof publicEnvSchema>;

// ---------------------------------------------------------------------------
// Connection string helpers
// ---------------------------------------------------------------------------

/**
 * Returns the appropriate database connection string for the given context.
 *
 * Use POOLED for: all API route queries, server components, short transactions.
 * Use DIRECT for: migrations, webhook handlers, LISTEN/NOTIFY, long queries.
 *
 * The distinction matters because Supavisor Transaction mode has a
 * connection timeout and will drop connections that hold open transactions
 * longer than the pool's idle timeout.
 */
export function getDatabaseUrl(
  mode: "pooled" | "direct" = "pooled",
): string {
  return mode === "pooled"
    ? serverEnv.DATABASE_URL
    : serverEnv.DATABASE_URL_DIRECT;
}

/**
 * True when running in a production Vercel deployment.
 * Use this to gate behaviors that must never run in preview or dev.
 */
export const isProduction =
  serverEnv.NODE_ENV === "production" &&
  process.env["VERCEL_ENV"] === "production";
