/**
 * src/app/api/rooms/[id]/invite/route.ts
 *
 * POST /api/rooms/:id/invite
 *
 * Generates a fresh invite token for the room, stores its SHA-256 hash,
 * and returns the invite URL. Only the host may call this.
 *
 * Rotating the token invalidates any previously shared link, so guests who
 * haven't joined yet will need the new URL. This is acceptable — the host
 * is explicitly requesting a fresh link.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  createSupabaseRouteHandlerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";
import { randomHex } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVITE_TTL_MS = 48 * 60 * 60 * 1_000;

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface SuccessBody { readonly inviteUrl: string }
interface ErrorBody   { readonly error: string }

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse<SuccessBody | ErrorBody>> {
  const roomId = params.id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomId)) {
    return NextResponse.json({ error: "Invalid room ID" }, { status: 400 });
  }

  // Auth
  const authClient = createSupabaseRouteHandlerClient();
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError !== null || user === null) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const supabase = createSupabaseServiceClient();

  // Verify host
  const { data: room } = await supabase
    .from("rooms")
    .select("id, host_id, status")
    .eq("id", roomId)
    .single();

  if (room === null) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }
  if ((room as { host_id: string }).host_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if ((room as { status: string }).status === "closed") {
    return NextResponse.json({ error: "Room is closed" }, { status: 410 });
  }

  // Generate fresh token
  const rawToken       = randomHex(32);
  const tokenHash      = await sha256Hex(rawToken);
  const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { error: updateError } = await supabase
    .from("rooms")
    .update({
      invite_token_hash: tokenHash,
      invite_expires_at: inviteExpiresAt,
    })
    .eq("id", roomId);

  if (updateError !== null) {
    return NextResponse.json({ error: "Failed to rotate invite token" }, { status: 500 });
  }

  const origin    = new URL(request.url).origin;
  const inviteUrl = `${origin}/rooms/join?token=${rawToken}`;

  return NextResponse.json({ inviteUrl }, { status: 200 });
}
