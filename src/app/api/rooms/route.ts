/**
 * src/app/api/rooms/route.ts
 *
 * POST /api/rooms — Create a new watch room.
 *
 * Security:
 *   - Requires an authenticated Supabase session (requireUser → getUser network call).
 *   - Inserts the host as an active participant row, which is the prerequisite
 *     for the token endpoint (/api/room/[id]/token) to mint a LiveKit JWT.
 *
 * Returns:
 *   201 { id, inviteUrl, liveKitRoomName }
 *   400 if body is malformed or platform is invalid
 *   401 if unauthenticated
 *   500 on DB error
 *
 * Invite token:
 *   A 32-byte (64-char hex) raw token is generated client-side-visible only
 *   once, here. Its SHA-256 hash is stored in rooms.invite_token_hash.
 *   The raw token is embedded in the returned inviteUrl and never persisted.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseRouteHandlerClient,
  requireUser,
  AuthRequiredError,
} from "@/lib/supabase/server";
import { randomHex } from "@/lib/utils";
import type { Platform, Json } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_PLATFORMS = new Set<string>(
  ["youtube", "jiohotstar", "netflix", "primevideo"] satisfies Platform[],
);

/** Invite links expire after 48 hours (matches the dialog copy). */
const INVITE_TTL_MS = 48 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoomSettings {
  content_id?: string;
  content_title?: string;
  max_participants?: number;
  has_international_guests?: boolean;
  require_approval?: boolean;
  allow_chat?: boolean;
  allow_reactions?: boolean;
  sync_tolerance_ms?: number;
}

interface CreateRoomResponse {
  readonly id: string;
  readonly inviteUrl: string;
  readonly liveKitRoomName: string;
}

interface ErrorResponse {
  readonly error: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
): Promise<NextResponse<CreateRoomResponse | ErrorResponse>> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  let userId: string;

  try {
    const user = await requireUser();
    userId = user.id;
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return NextResponse.json<ErrorResponse>(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    throw err;
  }

  // ── 2. Parse + validate body ─────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ErrorResponse>(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const raw = body as Record<string, unknown>;

  if (
    typeof raw["platform"] !== "string" ||
    !VALID_PLATFORMS.has(raw["platform"])
  ) {
    return NextResponse.json<ErrorResponse>(
      { error: `Invalid platform. Must be one of: ${[...VALID_PLATFORMS].join(", ")}` },
      { status: 400 },
    );
  }

  const platform = raw["platform"] as Platform;
  const settings = (raw["settings"] ?? {}) as RoomSettings;

  // ── 3. Generate identifiers ──────────────────────────────────────────────
  const rawToken = randomHex(32);                              // 64-char hex — sent to client once, never stored
  const tokenHash = await sha256Hex(rawToken);                 // SHA-256 hash — stored in DB
  const livekitRoomName = `whs-${randomHex(8)}`;              // unique LiveKit room name
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  // ── 4. Insert room ───────────────────────────────────────────────────────
  const supabase = createSupabaseRouteHandlerClient();

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .insert({
      host_id: userId,
      platform,
      status: "waiting" as const,
      livekit_room_name: livekitRoomName,
      invite_token_hash: tokenHash,
      invite_expires_at: inviteExpiresAt,
      settings: settings as unknown as Json,
    })
    .select("id, livekit_room_name")
    .single();

  if (roomError !== null || room === null) {
    console.error("[WHS] Failed to insert room:", roomError);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to create room. Please try again." },
      { status: 500 },
    );
  }

  // ── 5. Insert host participant row ───────────────────────────────────────
  //
  // Required — the token endpoint (/api/room/[id]/token) gates token minting
  // on the caller having an active participant row (left_at IS NULL).
  // Without this row, the host would be locked out of their own room.

  const { error: participantError } = await supabase
    .from("participants")
    .insert({
      room_id: room.id,
      user_id: userId,
      role: "host" as const,
      device_type: "primary" as const,
    });

  if (participantError !== null) {
    console.error("[WHS] Failed to insert host participant:", participantError);
    // Room exists — clean up to avoid orphaned room
    await supabase.from("rooms").delete().eq("id", room.id);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to initialise room membership. Please try again." },
      { status: 500 },
    );
  }

  // ── 6. Build invite URL ──────────────────────────────────────────────────
  const origin = new URL(request.url).origin;
  const inviteUrl = `${origin}/rooms/join?token=${rawToken}`;

  console.info("[WHS] Room created:", { roomId: room.id, userId, platform });

  return NextResponse.json<CreateRoomResponse>(
    {
      id: room.id,
      inviteUrl,
      liveKitRoomName: livekitRoomName,
    },
    {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
