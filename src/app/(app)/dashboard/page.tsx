/**
 * src/app/(app)/dashboard/page.tsx
 *
 * Primary host dashboard — Server Component.
 *
 * Data fetched server-side:
 *   - User profile (subscription tier, display name)
 *   - User's rooms (ordered by created_at DESC, last 30)
 *
 * Client interactivity is delegated to:
 *   - <CreateRoomDialog> — multi-step room creation with CompatibilityChecker
 *   - <DashboardClient> — room card grid with optimistic updates
 *
 * Performance targets:
 *   - LCP: Room grid server-rendered HTML → no client waterfall
 *   - CLS: All cards use explicit aspect ratios; no layout shift on hydration
 */

import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Crown,
  Clock,
  Tv2,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { createSupabaseServerComponentClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { DashboardClient } from "./_components/dashboard-client";
import type { RoomRow, UserRow } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata = {
  title: "Dashboard",
};

// ---------------------------------------------------------------------------
// Platform display map
// ---------------------------------------------------------------------------

const PLATFORM_LABELS: Record<string, string> = {
  youtube:    "YouTube",
  jiohotstar: "JioHotstar",
  netflix:    "Netflix",
  primevideo: "Prime Video",
};

const PLATFORM_BADGE_VARIANT: Record<
  string,
  | "youtube"
  | "jiohotstar"
  | "netflix"
  | "primevideo"
  | "default"
> = {
  youtube:    "youtube",
  jiohotstar: "jiohotstar",
  netflix:    "netflix",
  primevideo: "primevideo",
};

// ---------------------------------------------------------------------------
// Server-side room card (static, no interactivity)
// ---------------------------------------------------------------------------

function RoomCard({ room }: { room: RoomRow }) {
  const platformLabel =
    PLATFORM_LABELS[room.platform] ?? room.platform;

  const platformVariant =
    PLATFORM_BADGE_VARIANT[room.platform] ?? "default";

  const statusVariant =
    room.status === "active"
      ? "success"
      : room.status === "waiting"
      ? "warning"
      : "muted";

  return (
    <article className="group relative flex flex-col rounded-2xl bg-surface shadow-card ring-1 ring-inset ring-white/[0.06] transition-all duration-200 hover:shadow-card-hover hover:ring-white/[0.10]">
      {/* Card header */}
      <div className="flex items-start justify-between p-4 pb-3">
        <div className="flex items-center gap-2.5">
          {/* Status indicator */}
          <span
            className={`status-dot status-dot--${room.status}`}
            aria-label={`Room status: ${room.status}`}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">
              {typeof room.settings === "object" &&
              room.settings !== null &&
              "content_title" in room.settings &&
              typeof room.settings["content_title"] === "string" &&
              room.settings["content_title"].length > 0
                ? room.settings["content_title"]
                : "Untitled Session"}
            </p>
          </div>
        </div>
        <Badge variant={statusVariant} dot className="ml-2 shrink-0 capitalize">
          {room.status}
        </Badge>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-3 px-4 pb-4 text-2xs text-neutral-600">
        <Badge variant={platformVariant} className="text-2xs">
          {platformLabel}
        </Badge>
        <span className="flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" aria-hidden="true" />
          {formatDistanceToNow(new Date(room.created_at), { addSuffix: true })}
        </span>
      </div>

      {/* Action link — full card is clickable for active/waiting rooms */}
      {room.status !== "closed" && (
        <Link
          href={`/rooms/${room.id}`}
          className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          aria-label={`Open room: ${platformLabel} session`}
        >
          <span className="sr-only">Open room</span>
        </Link>
      )}

      {/* Chevron — decorative, hidden from assistive tech */}
      {room.status !== "closed" && (
        <ChevronRight
          className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-700 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-neutral-500"
          aria-hidden="true"
        />
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyRooms() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-white/[0.08] py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 ring-1 ring-inset ring-accent/20">
        <Tv2 className="h-6 w-6 text-accent" aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm font-medium text-neutral-300">No rooms yet</p>
        <p className="mt-1 text-xs text-neutral-600">
          Create your first watch session to get started
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Premium upsell banner (shown to free-tier hosts)
// ---------------------------------------------------------------------------

function PremiumBanner() {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-violet-900/40 via-purple-900/30 to-transparent p-5 ring-1 ring-inset ring-violet-500/20">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-white">
              Unlock Premium
            </h3>
          </div>
          <p className="mt-1.5 text-xs text-neutral-400">
            Host unlimited rooms, add up to 50 guests, and get priority sync for
            the smoothest experience.
          </p>
        </div>
        <Link
          href="/billing"
          className="shrink-0 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20 transition-colors hover:bg-amber-500/15"
        >
          Upgrade
        </Link>
      </div>
      {/* Decorative blob */}
      <div
        className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-violet-600/10 blur-2xl"
        aria-hidden="true"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats summary row
// ---------------------------------------------------------------------------

function StatRow({
  rooms,
  profile,
}: {
  rooms: RoomRow[];
  profile: UserRow | null;
}) {
  const activeCount = rooms.filter((r) => r.status === "active").length;
  const totalCount = rooms.length;

  const stats = [
    {
      label: "Active rooms",
      value: activeCount,
      icon: Tv2,
      badge: undefined,
    },
    {
      label: "Total sessions",
      value: totalCount,
      icon: Clock,
      badge: undefined,
    },
    {
      label: "Plan",
      value:
        profile?.subscription_tier === "premium" ? "Premium" : "Free",
      icon: Crown,
      badge: profile?.subscription_tier === "premium" ? ("premium" as const) : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map(({ label, value, icon: Icon, badge }) => (
        <div
          key={label}
          className="flex flex-col gap-1 rounded-xl bg-surface p-4 shadow-card ring-1 ring-inset ring-white/[0.06]"
        >
          <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-neutral-600">
            <Icon className="h-2.5 w-2.5" aria-hidden="true" />
            {label}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-semibold tracking-tight text-white">
              {value}
            </span>
            {badge !== undefined && (
              <Badge variant={badge} className="text-2xs">
                {String(value)}
              </Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page — Server Component
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const supabase = createSupabaseServerComponentClient();

  // Auth check — middleware handles redirect, but this is the definitive guard.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Parallel data fetch — rooms + profile
  const [profileResult, roomsResult] = await Promise.all([
    supabase
      .from("users")
      .select(
        "id, display_name, email, subscription_tier, created_at",
      )
      .eq("id", user.id)
      .single(),

    supabase
      .from("rooms")
      .select("*")
      .eq("host_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  const profile = profileResult.data;
  // Supabase infers SelectQueryError into the union under strict mode for select("*").
  // The runtime value is always RoomRow[] here — cast is safe.
  const rooms = (roomsResult.data ?? []) as unknown as RoomRow[];

  const displayName =
    profile?.display_name ??
    user.email?.split("@")[0] ??
    "Host";

  const isPremium = profile?.subscription_tier === "premium";
  const activeRooms = rooms.filter((r) => r.status === "active");
  const closedRooms = rooms.filter((r) => r.status === "closed");

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      {/* Page header */}
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-display text-white">
              Welcome back
            </h1>
            {isPremium && (
              <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-2xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20">
                <Crown className="h-2.5 w-2.5" aria-hidden="true" />
                Premium
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            {displayName}
            {profile?.email !== undefined && profile.email !== displayName
              ? ` · ${profile.email}`
              : ""}
          </p>
        </div>

        {/* Create Room — client component handles the dialog */}
        <DashboardClient
          userId={user.id}
          isPremium={isPremium}
          initialRooms={rooms}
        />
      </header>

      {/* Stats */}
      <section aria-label="Your statistics" className="mb-8">
        <StatRow rooms={rooms} profile={profile ?? null} />
      </section>

      {/* Premium upsell — only for free users */}
      {!isPremium && (
        <section aria-label="Upgrade to Premium" className="mb-8">
          <PremiumBanner />
        </section>
      )}

      {/* Active rooms */}
      {activeRooms.length > 0 && (
        <section aria-labelledby="active-rooms-heading" className="mb-8">
          <div className="mb-4 flex items-center gap-2">
            <h2
              id="active-rooms-heading"
              className="text-sm font-semibold text-white"
            >
              Live Now
            </h2>
            <Badge variant="success" dot>
              {activeRooms.length} active
            </Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {activeRooms.map((room) => (
              <RoomCard key={room.id} room={room} />
            ))}
          </div>
        </section>
      )}

      {/* All/recent rooms */}
      <section aria-labelledby="rooms-heading">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="rooms-heading" className="text-sm font-semibold text-white">
            {activeRooms.length > 0 ? "Past Sessions" : "Your Rooms"}
          </h2>
          {rooms.length > 0 && (
            <span className="text-xs text-neutral-600">
              {rooms.length} total
            </span>
          )}
        </div>

        {rooms.length === 0 ? (
          <EmptyRooms />
        ) : closedRooms.length === 0 && activeRooms.length > 0 ? (
          <p className="text-xs text-neutral-700">
            No past sessions yet.
          </p>
        ) : (
          <Suspense
            fallback={
              <div className="grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="skeleton h-[88px] rounded-2xl"
                    aria-hidden="true"
                  />
                ))}
              </div>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {closedRooms.map((room) => (
                <RoomCard key={room.id} room={room} />
              ))}
            </div>
          </Suspense>
        )}
      </section>
    </div>
  );
}
