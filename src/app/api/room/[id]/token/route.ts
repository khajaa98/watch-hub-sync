/**
 * src/app/api/room/[id]/token/route.ts
 *
 * Secure LiveKit Access Token Provisioning Endpoint.
 *
 * ─── ZERO-PROXY LEGAL MANDATE ────────────────────────────────────────────────
 * This API mints a LiveKit token scoped ONLY to:
 *   • canPublishData: true   — sync DataChannel messages (play/pause/seek)
 *   • canPublish: false      — NO audio/video track publishing whatsoever
 *   • canSubscribe: false    — NO media track subscription whatsoever
 *
 * This service NEVER proxies, intercepts, retransmits, or relays any video
 * stream. The LiveKit room carries only timestamped playback-state signals.
 * All DRM-protected content is delivered exclusively by the OTT platform's
 * own CDN directly to the viewer's browser, subject to that platform's EME /
 * Widevine / HDCP policies.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Security gates (must ALL pass before a token is minted):
 *
 *   1. Supabase `getUser()` — network-verified session, never trusts JWT alone
 *   2. Room existence — room must exist and not be "closed"
 *   3. Participant row — caller must have an active (left_at IS NULL) row in
 *      the `participants` table for this room_id + user_id. This prevents a
 *      valid session holder from joining a room they were never invited to.
 *   4. Environment — LIVEKIT_API_KEY + LIVEKIT_API_SECRET must be present;
 *      any missing var returns 500 rather than minting with an empty secret.
 *
 * Token TTL: 4 hours. LiveKit will refuse room entry after expiry.
 * The client hook is responsible for requesting a fresh token before expiry.
 */

import { NextResponse, type NextRequest } from "next/server";
import { AccessToken, type VideoGrant } from "livekit-server-sdk";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/server";
import { createLogger } from "@/lib/logger";
import type { RoomRow, ParticipantRow, UserRow } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Token TTL as a string understood by the livekit-server-sdk. */
const TOKEN_TTL = "4h" as const;

/** How many seconds before expiry the client should refresh (15 min). */
const REFRESH_BEFORE_EXPIRY_S = 60 * 15;

const log = createLogger({ module: "api/room/token" });

// ---------------------------------------------------------------------------
// Route segment config
// ---------------------------------------------------------------------------

// Node runtime — livekit-server-sdk uses Node crypto internally for signing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenResponseBody {
  readonly token: string;
  readonly livekitUrl: string;
  readonly identity: string;
  readonly roomName: string;
  /** Unix timestamp (seconds) when the client should request a fresh token. */
  readonly refreshAt: number;
}

interface ErrorResponseBody {
  readonly error: string;
  readonly code: string;
}

// ---------------------------------------------------------------------------
// Helper — environment guard
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse<TokenResponseBody | ErrorResponseBody>> {
  const roomId = params.id;

  // ── 0. Validate route param ──────────────────────────────────────────────
  if (
    typeof roomId !== "string" ||
    roomId.trim().length === 0 ||
    // UUIDs only — prevent path traversal
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      roomId,
    )
  ) {
    return NextResponse.json<ErrorResponseBody>(
      { error: "Invalid room ID", code: "INVALID_PARAM" },
      { status: 400 },
    );
  }

  // ── 1. Environment guard — fail fast before any DB I/O ──────────────────
  let apiKey: string;
  let apiSecret: string;
  let livekitUrl: string;

  try {
    apiKey     = requireEnv("LIVEKIT_API_KEY");
    apiSecret  = requireEnv("LIVEKIT_API_SECRET");
    livekitUrl = requireEnv("LIVEKIT_URL");
  } catch (err) {
    log.error({ err }, "LiveKit environment variables missing");
    return NextResponse.json<ErrorResponseBody>(
      { error: "Service misconfigured", code: "CONFIG_ERROR" },
      { status: 500 },
    );
  }

  // ── 2. Supabase session — network-verified, not JWT-only ────────────────
  const supabase = createSupabaseRouteHandlerClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError !== null || user === null) {
    return NextResponse.json<ErrorResponseBody>(
      { error: "Authentication required", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  // ── 3. Room existence + status check ────────────────────────────────────
  const { data: roomRaw, error: roomError } = await supabase
    .from("rooms")
    .select("id, livekit_room_name, status, host_id")
    .eq("id", roomId)
    .single();
  const room = roomRaw as unknown as RoomRow | null;

  if (roomError !== null || room === null) {
    return NextResponse.json<ErrorResponseBody>(
      { error: "Room not found", code: "ROOM_NOT_FOUND" },
      { status: 404 },
    );
  }

  if (room.status === "closed") {
    return NextResponse.json<ErrorResponseBody>(
      { error: "This room has ended", code: "ROOM_CLOSED" },
      { status: 410 },
    );
  }

  // ── 4. Participant authorization gate ───────────────────────────────────
  //
  // A valid Supabase session is NOT sufficient — the user must have an active
  // participant row (left_at IS NULL) for this specific room. This prevents:
  //
  //   • Uninvited session holders from joining private rooms
  //   • Kicked participants from re-obtaining a token
  //   • Token minting for rooms the user browsed but never joined
  //
  // The host is always pre-inserted as a participant during room creation
  // (via POST /api/rooms), so this check is symmetric for all roles.

  const { data: participantRaw, error: participantError } = await supabase
    .from("participants")
    .select("id, role, device_type")
    .eq("room_id", roomId)
    .eq("user_id", user.id)
    .is("left_at", null)
    .maybeSingle();
  const participant = participantRaw as unknown as ParticipantRow | null;

  if (participantError !== null) {
    log.error({ participantError, roomId, userId: user.id }, "Participant query error");
    return NextResponse.json<ErrorResponseBody>(
      { error: "Failed to verify room membership", code: "DB_ERROR" },
      { status: 500 },
    );
  }

  if (participant === null) {
    log.warn({ roomId, userId: user.id }, "Token requested without active participant row");
    return NextResponse.json<ErrorResponseBody>(
      { error: "You are not a member of this room", code: "NOT_A_PARTICIPANT" },
      { status: 403 },
    );
  }

  // ── 5. Fetch user display profile for token identity ────────────────────
  const { data: profileRaw } = await supabase
    .from("users")
    .select("display_name, email")
    .eq("id", user.id)
    .single();
  const profile = profileRaw as unknown as UserRow | null;

  const displayName =
    profile?.display_name ??
    profile?.email?.split("@")[0] ??
    "Guest";

  // ── 6. Mint LiveKit access token ─────────────────────────────────────────
  //
  // CRITICAL: canPublish and canSubscribe are FALSE.
  // This room is a data-only sync channel — no audio/video tracks are
  // transmitted through LiveKit under any circumstances.

  const identity = `${user.id}:${participant.device_type}`;

  const grant: VideoGrant = {
    roomJoin:       true,
    room:           room.livekit_room_name,
    canPublishData: true,   // DataChannel only — sync events
    canPublish:     false,  // NO audio/video publish
    canSubscribe:   false,  // NO audio/video subscribe
    hidden:         false,
  };

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: `${displayName} (${participant.device_type})`,
    ttl:  TOKEN_TTL,
  });
  at.addGrant(grant);

  let token: string;
  try {
    token = await at.toJwt();
  } catch (err) {
    log.error({ err, roomId, userId: user.id }, "LiveKit token signing failed");
    return NextResponse.json<ErrorResponseBody>(
      { error: "Failed to generate access token", code: "TOKEN_ERROR" },
      { status: 500 },
    );
  }

  // refreshAt: 4 hours from now minus 15-minute cushion
  const refreshAt =
    Math.floor(Date.now() / 1000) + 4 * 60 * 60 - REFRESH_BEFORE_EXPIRY_S;

  log.info(
    {
      roomId,
      userId: user.id,
      role: participant.role,
      deviceType: participant.device_type,
      identity,
    },
    "LiveKit token minted",
  );

  return NextResponse.json<TokenResponseBody>(
    {
      token,
      livekitUrl,
      identity,
      roomName: room.livekit_room_name,
      refreshAt,
    },
    {
      status: 200,
      headers: {
        // Never cache token responses
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma":        "no-cache",
      },
    },
  );
}
