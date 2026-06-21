/**
 * src/app/(app)/rooms/join/page.tsx
 *
 * Guest invite redemption — Server Component.
 *
 * Flow:
 *   1. Extract ?token from the URL (the raw 64-char hex invite token)
 *   2. Verify the user is authenticated (middleware already guards this, but
 *      we check again for defence in depth)
 *   3. Hash the token with SHA-256 and look it up in rooms.invite_token_hash
 *   4. Validate the room is still open and the invite hasn't expired
 *   5. Upsert a guest participant row (idempotent — safe to revisit the link)
 *   6. redirect() to /rooms/[id]
 *
 * This page renders no UI — it's a pure server-side redirect handler.
 * The middleware at src/middleware.ts preserves ?token=... in the redirect
 * param so it survives the login round-trip.
 */

import { redirect, notFound } from "next/navigation";
import {
  createSupabaseServerComponentClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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
// Page
// ---------------------------------------------------------------------------

interface JoinPageProps {
  readonly searchParams: Record<string, string | string[] | undefined>;
}

export default async function JoinPage({ searchParams }: JoinPageProps) {
  // ── 1. Extract + validate the raw invite token ───────────────────────────
  const rawToken =
    typeof searchParams["token"] === "string" ? searchParams["token"] : null;

  if (rawToken === null || rawToken.length === 0) {
    notFound();
  }

  // ── 2. Confirm authentication ─────────────────────────────────────────────
  // Middleware already redirects unauthenticated users to /login, but we
  // verify here too so this page can never hand out a room token without auth.
  const authClient = createSupabaseServerComponentClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (user === null) {
    redirect(
      `/login?redirect=${encodeURIComponent(`/rooms/join?token=${rawToken}`)}`,
    );
  }

  // ── 3. Hash the token and find the room ───────────────────────────────────
  const tokenHash = await sha256Hex(rawToken);
  const supabase  = createSupabaseServiceClient();

  const { data: roomRaw, error: roomError } = await supabase
    .from("rooms")
    .select("id, status, invite_expires_at, host_id")
    .eq("invite_token_hash", tokenHash)
    .maybeSingle();

  if (roomError !== null || roomRaw === null) {
    // Token not found — link is invalid or was regenerated
    redirect("/dashboard?invite=invalid");
  }

  const room = roomRaw as {
    id: string;
    status: string;
    invite_expires_at: string | null;
    host_id: string;
  };

  // ── 4. Validate room state ────────────────────────────────────────────────
  if (room.status === "closed") {
    redirect("/dashboard?room=ended");
  }

  if (
    room.invite_expires_at !== null &&
    new Date(room.invite_expires_at) < new Date()
  ) {
    redirect("/dashboard?invite=expired");
  }

  // ── 5. Upsert guest participant row ───────────────────────────────────────
  // Check for an existing active row first (idempotent — hosts and returning
  // guests should not get a duplicate row).
  const { data: existing } = await supabase
    .from("participants")
    .select("id")
    .eq("room_id", room.id)
    .eq("user_id", user.id)
    .is("left_at", null)
    .maybeSingle();

  if (existing === null) {
    const { error: insertError } = await supabase
      .from("participants")
      .insert({
        room_id:     room.id,
        user_id:     user.id,
        role:        "guest"   as const,
        device_type: "primary" as const,
      });

    if (insertError !== null) {
      console.error("[WHS] Failed to insert guest participant:", insertError.message);
      // Non-fatal: the room page will show "not a member" and the user can retry.
    }
  }

  // ── 6. Enter the room ─────────────────────────────────────────────────────
  redirect(`/rooms/${room.id}`);
}
