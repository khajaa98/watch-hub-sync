/**
 * src/app/(app)/rooms/page.tsx
 *
 * "Your Rooms" — all active rooms where the current user is host or guest.
 * Server Component; uses the service client to bypass RLS.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { Clock, Tv2, Radio, Crown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  createSupabaseServerComponentClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";
import { Badge }        from "@/components/ui/badge";
import { cn }           from "@/lib/utils";
import type { RoomRow } from "@/types/supabase";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rooms · Watch Hub Sync" };

// ---------------------------------------------------------------------------
// Platform config (mirrored from dashboard)
// ---------------------------------------------------------------------------

const PLATFORM_LABELS: Record<string, string> = {
  youtube:    "YouTube",
  jiohotstar: "JioHotstar",
  netflix:    "Netflix",
  primevideo: "Prime Video",
};

const PLATFORM_BADGE_VARIANT: Record<
  string,
  "youtube" | "jiohotstar" | "netflix" | "primevideo" | "default"
> = {
  youtube:    "youtube",
  jiohotstar: "jiohotstar",
  netflix:    "netflix",
  primevideo: "primevideo",
};

// ---------------------------------------------------------------------------
// Room card
// ---------------------------------------------------------------------------

function RoomCard({
  room,
  role,
}: {
  room: RoomRow;
  role: "host" | "guest";
}) {
  const platformLabel   = PLATFORM_LABELS[room.platform]        ?? room.platform;
  const platformVariant = PLATFORM_BADGE_VARIANT[room.platform] ?? "default";

  const statusVariant =
    room.status === "active"  ? "success"
    : room.status === "waiting" ? "warning"
    : "muted";

  const contentTitle =
    typeof room.settings === "object" &&
    room.settings !== null &&
    "content_title" in room.settings &&
    typeof room.settings["content_title"] === "string" &&
    room.settings["content_title"].length > 0
      ? room.settings["content_title"]
      : "Untitled Session";

  return (
    <article className="group relative flex flex-col gap-3 rounded-xl bg-surface p-4 ring-1 ring-white/[0.06] transition-all duration-200 hover:bg-surface-raised hover:ring-white/[0.10]">
      {/* Role badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-sm font-medium text-white">{contentTitle}</p>
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-600">
            {role === "host" && (
              <span className="flex items-center gap-0.5 text-yellow-500/80">
                <Crown className="h-2.5 w-2.5" />
                Host
              </span>
            )}
            {role === "guest" && (
              <span className="flex items-center gap-0.5 text-violet-400/80">
                <Radio className="h-2.5 w-2.5" />
                Guest
              </span>
            )}
            <span>·</span>
            <Clock className="h-2.5 w-2.5" />
            {formatDistanceToNow(new Date(room.created_at), { addSuffix: true })}
          </div>
        </div>
        <Badge variant={statusVariant} dot className="shrink-0 capitalize">
          {room.status}
        </Badge>
      </div>

      <div className="flex items-center justify-between">
        <Badge variant={platformVariant}>{platformLabel}</Badge>
        {room.status !== "closed" && (
          <span className="text-[11px] font-medium text-violet-400 transition-colors group-hover:text-violet-300">
            Re-enter →
          </span>
        )}
      </div>

      {room.status !== "closed" && (
        <Link
          href={`/rooms/${room.id}`}
          className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          aria-label={`Re-enter room: ${contentTitle}`}
        >
          <span className="sr-only">Re-enter room</span>
        </Link>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyRooms() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-white/[0.07] py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-500/10 ring-1 ring-inset ring-violet-500/20">
        <Tv2 className="h-5 w-5 text-violet-400" />
      </div>
      <div>
        <p className="text-sm font-medium text-neutral-300">No active watch parties</p>
        <p className="mt-1 text-xs text-neutral-600">
          Head to the dashboard to create or join a room
        </p>
      </div>
      <Link
        href="/dashboard"
        className={cn(
          "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold",
          "bg-accent text-white shadow-[0_0_16px_rgba(124,58,237,0.25)]",
          "transition-all hover:bg-accent/80",
        )}
      >
        Go to Dashboard
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function RoomsPage() {
  // Auth
  const authClient = createSupabaseServerComponentClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (user === null) redirect("/login?redirect=/rooms");

  const supabase = createSupabaseServiceClient();

  // Find all participant rows for this user that are still active
  const { data: participantRows } = await supabase
    .from("participants")
    .select("room_id, role")
    .eq("user_id", user.id)
    .is("left_at", null);

  const roomIds = (participantRows ?? []).map((p) => p.room_id as string);

  // Fetch those rooms (exclude closed)
  const rooms: RoomRow[] = [];
  const roleByRoom: Record<string, "host" | "guest"> = {};

  if (roomIds.length > 0) {
    const { data: roomRows } = await supabase
      .from("rooms")
      .select("*")
      .in("id", roomIds)
      .neq("status", "closed")
      .order("created_at", { ascending: false });

    for (const row of roomRows ?? []) {
      const r = row as RoomRow;
      rooms.push(r);
      const participantRole = participantRows?.find((p) => p.room_id === r.id)?.role;
      roleByRoom[r.id] = participantRole === "host" ? "host" : "guest";
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-600">
            Active Sessions
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
            Your Rooms
          </h1>
        </div>
        <Link
          href="/dashboard"
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold",
            "bg-accent text-white shadow-[0_0_16px_rgba(124,58,237,0.25)]",
            "transition-all hover:bg-accent/80",
          )}
        >
          + New Room
        </Link>
      </div>

      {/* Grid */}
      {rooms.length === 0 ? (
        <EmptyRooms />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              role={roleByRoom[room.id] ?? "guest"}
            />
          ))}
        </div>
      )}
    </div>
  );
}
