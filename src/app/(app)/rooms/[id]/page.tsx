/**
 * src/app/(app)/rooms/[id]/page.tsx
 *
 * Watch room page — Server Component.
 * Verifies the user is an active participant, then hands off to RoomClient.
 */

import { notFound, redirect } from "next/navigation";
import { createSupabaseServerComponentClient } from "@/lib/supabase/server";
import { RoomClient } from "./_components/room-client";
import type { RoomRow, UserRow } from "@/types/supabase";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return { title: "Room · Watch Hub Sync" };
}

interface RoomPageProps {
  readonly params: { id: string };
  readonly searchParams: Record<string, string | string[] | undefined>;
}

export default async function RoomPage({ params, searchParams }: RoomPageProps) {
  const { id: roomId } = params;

  // Basic UUID guard
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomId)) {
    notFound();
  }

  const supabase = createSupabaseServerComponentClient();

  // ── Auth ────────────────────────────────────────────────────────────────
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/rooms/${roomId}`);
  }

  // ── Fetch room ──────────────────────────────────────────────────────────
  const { data: roomRaw, error: roomError } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .single();

  const room = roomRaw as unknown as RoomRow | null;

  if (roomError !== null || room === null) {
    notFound();
  }

  if (room.status === "closed") {
    // Room ended — send back to dashboard with a flash message
    redirect("/dashboard?room=ended");
  }

  // ── Verify participant ───────────────────────────────────────────────────
  const { data: participantRaw } = await supabase
    .from("participants")
    .select("id, role")
    .eq("room_id", roomId)
    .eq("user_id", user.id)
    .is("left_at", null)
    .maybeSingle();

  // Not a participant — send to dashboard
  if (participantRaw === null) {
    redirect("/dashboard");
  }

  const participant = participantRaw as unknown as { id: string; role: string };
  const isHost = room.host_id === user.id || participant.role === "host";

  // ── Fetch display name ──────────────────────────────────────────────────
  const { data: profileRaw } = await supabase
    .from("users")
    .select("display_name, email")
    .eq("id", user.id)
    .single();
  const profile = profileRaw as unknown as Pick<UserRow, "display_name" | "email"> | null;
  const displayName =
    profile?.display_name ??
    profile?.email?.split("@")[0] ??
    "Guest";

  // ── Invite URL from query param (set by create-room-dialog on navigation) ─
  const rawInvite = searchParams["invite"];
  const inviteUrl = typeof rawInvite === "string" && rawInvite.length > 0
    ? rawInvite
    : null;

  return (
    <RoomClient
      roomId={roomId}
      room={room}
      isHost={isHost}
      inviteUrl={inviteUrl}
      userId={user.id}
      displayName={displayName}
    />
  );
}
