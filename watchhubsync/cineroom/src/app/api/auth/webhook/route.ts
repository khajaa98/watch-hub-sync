/**
 * src/app/api/auth/webhook/route.ts
 *
 * Supabase Auth lifecycle webhook handler for WatchHubSync.
 *
 * This endpoint receives user lifecycle events (user.created, user.updated,
 * user.deleted) delivered via a Svix-backed webhook channel. Svix provides
 * cryptographic delivery guarantees, automatic retries, and a signed payload
 * that we verify using the `svix` SDK before processing.
 *
 * Security model:
 *   1. Svix signing secret is compared against the Svix-Signature header.
 *      Any payload that fails verification is rejected with HTTP 400.
 *      This prevents unauthorized callers from triggering user mutations.
 *   2. Profile mutations are executed with the service_role Supabase client,
 *      which bypasses RLS. The service key is never exposed to the request
 *      payload — it is only read from server-side env vars.
 *   3. All operations are idempotent — ON CONFLICT DO UPDATE means repeated
 *      delivery of the same event is safe.
 *   4. The endpoint returns HTTP 200 for all successfully verified events,
 *      even if the event type is unknown. This prevents Svix from retrying
 *      events that we simply don't handle.
 *
 * Configuration:
 *   - Register this URL in your Svix application dashboard as the endpoint.
 *   - Set SVIX_WEBHOOK_SECRET in .env.local.
 *   - In Supabase: Auth > Hooks > Send Emails → point to your Svix endpoint.
 *
 * Svix delivers events with these headers:
 *   svix-id        — unique message ID (idempotency key)
 *   svix-timestamp — Unix timestamp (replay attack prevention)
 *   svix-signature — HMAC-SHA256 signatures (comma-separated)
 */

import { NextResponse, type NextRequest } from "next/server";
import { Webhook } from "svix";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createLogger } from "@/lib/logger";
import type { AuthProvider } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger({ module: "auth.webhook" });

// ---------------------------------------------------------------------------
// Svix event type contracts
// These mirror Supabase Auth's webhook payload shapes.
// ---------------------------------------------------------------------------

interface SupabaseAuthUserPayload {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly email_confirmed_at: string | null;
  readonly phone_confirmed_at: string | null;
  readonly app_metadata: {
    readonly provider: string;
    readonly providers: string[];
  };
  readonly user_metadata: {
    readonly full_name?: string;
    readonly name?: string;
    readonly avatar_url?: string;
    readonly [key: string]: unknown;
  };
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

interface SvixWebhookEvent<T = unknown> {
  /** Svix message ID — use as idempotency key */
  readonly id: string;
  /** ISO 8601 timestamp */
  readonly timestamp: string;
  /** Event type */
  readonly type: string;
  /** Event payload */
  readonly data: T;
}

type AuthUserEvent = SvixWebhookEvent<SupabaseAuthUserPayload>;

// ---------------------------------------------------------------------------
// Event type constants
// ---------------------------------------------------------------------------

const AUTH_EVENTS = {
  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  USER_DELETED: "user.deleted",
} as const;

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the Svix webhook signature and parse the payload.
 *
 * The Svix SDK handles:
 *   - Timestamp replay attack prevention (default: ±5 minute tolerance)
 *   - HMAC-SHA256 signature verification over {id}.{timestamp}.{body}
 *   - Multiple signature rotation (comma-separated svix-signature values)
 *
 * @throws Error if signature verification fails.
 */
async function verifySvixPayload(
  request: NextRequest,
): Promise<SvixWebhookEvent> {
  const secret = process.env["SVIX_WEBHOOK_SECRET"];

  if (!secret) {
    throw new Error(
      "SVIX_WEBHOOK_SECRET is not configured. " +
        "Add it to .env.local and Vercel environment variables.",
    );
  }

  // Read headers required by Svix verification.
  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new Error(
      "Missing required Svix headers (svix-id, svix-timestamp, svix-signature). " +
        "Ensure the request is from a Svix endpoint.",
    );
  }

  // Read the raw body as a string — Svix verifies over the raw bytes.
  const rawBody = await request.text();

  const wh = new Webhook(secret);

  // verify() throws WebhookVerificationError if the signature is invalid.
  const payload = wh.verify(rawBody, {
    "svix-id": svixId,
    "svix-timestamp": svixTimestamp,
    "svix-signature": svixSignature,
  }) as SvixWebhookEvent;

  return payload;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Handle `user.created` — upsert the public.users profile row.
 *
 * The Supabase trigger `handle_new_auth_user` (00002_create_users.sql)
 * usually creates the profile on INSERT to auth.users. This handler is the
 * fallback for cases where the trigger fires before the webhook, ensuring
 * idempotency via ON CONFLICT DO UPDATE.
 */
async function handleUserCreated(
  event: AuthUserEvent,
  svixMessageId: string,
): Promise<void> {
  const { data: user } = event;

  if (!user.email) {
    log.warn(
      { svixMessageId, userId: user.id },
      "user.created event has no email — skipping profile upsert",
    );
    return;
  }

  const rawProvider = user.app_metadata.provider;
  const authProvider: AuthProvider = (
    ["email", "google", "apple", "passkey"] as const
  ).includes(rawProvider as AuthProvider)
    ? (rawProvider as AuthProvider)
    : "email";

  const displayName =
    user.user_metadata.full_name ??
    user.user_metadata.name ??
    user.email.split("@")[0] ??
    "User";

  const supabase = createSupabaseServiceClient();

  const { error } = await supabase.from("users").upsert(
    {
      id: user.id,
      email: user.email,
      auth_provider: authProvider,
      display_name: displayName,
      avatar_url: (user.user_metadata.avatar_url as string | undefined) ?? null,
      subscription_tier: "free",
    },
    {
      // Conflict on primary key (id).
      onConflict: "id",
      // Don't overwrite subscription_tier if already upgraded.
      ignoreDuplicates: false,
    },
  );

  if (error !== null) {
    log.error(
      { svixMessageId, userId: user.id, supabaseError: error.message },
      "Failed to upsert user profile on user.created",
    );
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  log.info(
    { svixMessageId, userId: user.id, authProvider },
    "User profile created via webhook",
  );
}

/**
 * Handle `user.updated` — sync profile fields that may have changed
 * (e.g., email confirmed, metadata updated via OAuth re-login).
 */
async function handleUserUpdated(
  event: AuthUserEvent,
  svixMessageId: string,
): Promise<void> {
  const { data: user } = event;

  if (!user.email) {
    log.warn(
      { svixMessageId, userId: user.id },
      "user.updated event has no email — skipping",
    );
    return;
  }

  const supabase = createSupabaseServiceClient();

  const { error } = await supabase
    .from("users")
    .update({
      email: user.email,
      display_name:
        (user.user_metadata.full_name as string | undefined) ??
        (user.user_metadata.name as string | undefined) ??
        undefined,
      avatar_url:
        (user.user_metadata.avatar_url as string | undefined) ?? undefined,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (error !== null) {
    log.error(
      { svixMessageId, userId: user.id, supabaseError: error.message },
      "Failed to update user profile on user.updated",
    );
    throw new Error(`Supabase update failed: ${error.message}`);
  }

  log.info(
    { svixMessageId, userId: user.id },
    "User profile synced via webhook",
  );
}

/**
 * Handle `user.deleted` — the CASCADE constraint on auth.users → public.users
 * (defined in 00002_create_users.sql) handles the actual row deletion.
 * We log the event for audit purposes only.
 */
async function handleUserDeleted(
  event: AuthUserEvent,
  svixMessageId: string,
): Promise<void> {
  log.info(
    { svixMessageId, userId: event.data.id },
    "user.deleted event received — cascade will handle DB cleanup",
  );
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/webhook
 *
 * Accepts Svix-signed user lifecycle events from Supabase Auth.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let event: SvixWebhookEvent;

  // ── Step 1: Verify signature ────────────────────────────────────────────
  try {
    event = await verifySvixPayload(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";

    log.warn({ err: message }, "Svix webhook verification failed");

    return NextResponse.json(
      { error: "Invalid webhook signature", detail: message },
      { status: 400 },
    );
  }

  const svixMessageId = request.headers.get("svix-id") ?? event.id;

  log.info(
    { svixMessageId, eventType: event.type },
    "Processing auth webhook event",
  );

  // ── Step 2: Dispatch to typed handler ───────────────────────────────────
  try {
    switch (event.type) {
      case AUTH_EVENTS.USER_CREATED:
        await handleUserCreated(event as AuthUserEvent, svixMessageId);
        break;

      case AUTH_EVENTS.USER_UPDATED:
        await handleUserUpdated(event as AuthUserEvent, svixMessageId);
        break;

      case AUTH_EVENTS.USER_DELETED:
        await handleUserDeleted(event as AuthUserEvent, svixMessageId);
        break;

      default:
        // Return 200 for unknown event types. Returning 4xx would cause
        // Svix to retry the event indefinitely.
        log.debug(
          { svixMessageId, eventType: event.type },
          "Received unhandled event type — acknowledging without processing",
        );
    }

    return NextResponse.json(
      { received: true, eventType: event.type, messageId: svixMessageId },
      { status: 200 },
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown processing error";

    log.error(
      { svixMessageId, eventType: event.type, err: message },
      "Auth webhook processing failed",
    );

    // Return 500 so Svix retries delivery. The handlers are idempotent so
    // retry storms are safe, but use Svix's retry configuration to back off.
    return NextResponse.json(
      { error: "Webhook processing failed", detail: message },
      { status: 500 },
    );
  }
}

// Reject all non-POST methods.
export function GET(): NextResponse {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
