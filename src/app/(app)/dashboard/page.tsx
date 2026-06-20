/**
 * src/app/(app)/dashboard/page.tsx
 *
 * Cinematic host dashboard — Server Component.
 * Fetches profile + rooms in parallel, renders a theater-dark grid layout.
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
  PlusCircle,
  Radio,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { createSupabaseServerComponentClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { DashboardClient } from "./_components/dashboard-client";
import type { RoomRow, UserRow } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata = { title: "Dashboard · Watch Hub Sync" };

// ---------------------------------------------------------------------------
// Constants
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

function RoomCard({ room }: { room: RoomRow }) {
  const platformLabel   = PLATFORM_LABELS[room.platform]            ?? room.platform;
  const platformVariant = PLATFORM_BADGE_VARIANT[room.platform]     ?? "default";
  const statusVariant   = room.status === "active"  ? "success"
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
    <article className="group relative flex flex-col gap-3 rounded-xl bg-zinc-900 p-4 ring-1 ring-white/[0.06] transition-all duration-200 hover:bg-zinc-800/80 hover:ring-white/[0.10]">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm font-medium text-white">{contentTitle}</p>
        <Badge variant={statusVariant} dot className="shrink-0 capitalize">
          {room.status}
        </Badge>
      </div>

      <div className="flex items-center gap-2.5 text-xs text-zinc-600">
        <Badge variant={platformVariant}>{platformLabel}</Badge>
        <span className="flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          {formatDistanceToNow(new Date(room.created_at), { addSuffix: true })}
        </span>
      </div>

      {room.status !== "closed" && (
        <>
          <Link
            href={`/rooms/${room.id}`}
            className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            aria-label={`Open room: ${contentTitle}`}
          >
            <span className="sr-only">Open room</span>
          </Link>
          <ChevronRight className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-700 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-zinc-500" />
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyRooms() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-white/[0.07] py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-500/10 ring-1 ring-inset ring-violet-500/20">
        <Tv2 className="h-5 w-5 text-violet-400" />
      </div>
      <div>
        <p className="text-sm font-medium text-zinc-300">No sessions yet</p>
        <p className="mt-1 text-xs text-zinc-600">
          Create your first watch room to get started
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Premium upsell
// ---------------------------------------------------------------------------

function PremiumBanner() {
  return (
    <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-violet-900/40 via-violet-900/20 to-transparent p-5 ring-1 ring-inset ring-violet-500/15">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-sm font-semibold text-white">Unlock Premium</span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Unlimited rooms · 50 guests · priority sync · HD stream
          </p>
        </div>
        <Link
          href="/billing"
          className="shrink-0 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20 transition-colors hover:bg-amber-500/15"
        >
          Upgrade →
        </Link>
      </div>
      <div className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-violet-600/10 blur-3xl" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats strip
// ---------------------------------------------------------------------------

function StatsStrip({ rooms, profile }: { rooms: RoomRow[]; profile: UserRow | null }) {
  const activeCount = rooms.filter((r) => r.status === "active").length;

  const stats = [
    { label: "Live now",      value: activeCount,    icon: Radio,  accent: activeCount > 0 },
    { label: "Total rooms",   value: rooms.length,   icon: Tv2,    accent: false },
    { label: "Plan",          value: profile?.subscription_tier === "premium" ? "Premium" : "Free",
                                                      icon: Crown,  accent: profile?.subscription_tier === "premium" },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map(({ label, value, icon: Icon, accent }) => (
        <div
          key={label}
          className="flex flex-col gap-2 rounded-xl bg-zinc-900 p-4 ring-1 ring-inset ring-white/[0.06]"
        >
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-zinc-600">
            <Icon className="h-2.5 w-2.5" />
            {label}
          </div>
          <span
            className={cn(
              "text-xl font-semibold tracking-tight",
              accent ? "text-violet-300" : "text-white",
            )}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Page — Server Component
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const supabase = createSupabaseServerComponentClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [profileResult, roomsResult] = await Promise.all([
    supabase
      .from("users")
      .select("id, display_name, email, subscription_tier, created_at")
      .eq("id", user.id)
      .single(),
    supabase
      .from("rooms")
      .select("*")
      .eq("host_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  const profile = profileResult.data as unknown as UserRow | null;
  const rooms   = (roomsResult.data ?? []) as unknown as RoomRow[];

  const displayName = profile?.display_name ?? user.email?.split("@")[0] ?? "Host";
  const isPremium   = profile?.subscription_tier === "premium";
  const activeRooms = rooms.filter((r) => r.status === "active");
  const closedRooms = rooms.filter((r) => r.status === "closed");

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Ambient top glow */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[400px] bg-gradient-to-b from-violet-950/20 to-transparent"
        aria-hidden="true"
      />

      <div className="relative mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="mb-10 flex items-start justify-between gap-4">
          <div>
            <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-zinc-600">
              Host dashboard
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              Welcome back,{" "}
              <span className="text-zinc-300">{displayName}</span>
            </h1>
            {isPremium && (
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20">
                <Crown className="h-2.5 w-2.5" />
                Premium member
              </span>
            )}
          </div>

          {/* Create Room — client component owns the dialog */}
          <DashboardClient
            userId={user.id}
            isPremium={isPremium}
            initialRooms={rooms}
          />
        </header>

        {/* ── Stats ──────────────────────────────────────────────────────── */}
        <section aria-label="Statistics" className="mb-8">
          <StatsStrip rooms={rooms} profile={profile} />
        </section>

        {/* ── Create room hero CTA (only when no rooms yet) ─────────────── */}
        {rooms.length === 0 && (
          <section aria-label="Get started" className="mb-8">
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-violet-900/50 via-violet-900/20 to-zinc-900 p-8 text-center ring-1 ring-inset ring-violet-500/15">
              <div className="pointer-events-none absolute -top-12 left-1/2 h-40 w-60 -translate-x-1/2 rounded-full bg-violet-600/20 blur-3xl" />
              <PlusCircle className="mx-auto mb-4 h-8 w-8 text-violet-400" />
              <h2 className="text-base font-semibold text-white">Start your first watch party</h2>
              <p className="mt-1.5 text-sm text-zinc-400">
                Create a room, share the link, and watch together in perfect sync.
              </p>
            </div>
          </section>
        )}

        {/* ── Upsell ─────────────────────────────────────────────────────── */}
        {!isPremium && (
          <section aria-label="Upgrade" className="mb-8">
            <PremiumBanner />
          </section>
        )}

        {/* ── Live rooms ─────────────────────────────────────────────────── */}
        {activeRooms.length > 0 && (
          <section aria-labelledby="live-heading" className="mb-8">
            <div className="mb-4 flex items-center gap-2.5">
              <h2 id="live-heading" className="text-sm font-semibold text-white">
                Live Now
              </h2>
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                {activeRooms.length} active
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {activeRooms.map((room) => (
                <RoomCard key={room.id} room={room} />
              ))}
            </div>
          </section>
        )}

        {/* ── Past sessions ──────────────────────────────────────────────── */}
        <section aria-labelledby="sessions-heading">
          <div className="mb-4 flex items-center justify-between">
            <h2 id="sessions-heading" className="text-sm font-semibold text-white">
              {activeRooms.length > 0 ? "Past Sessions" : "Your Rooms"}
            </h2>
            {rooms.length > 0 && (
              <span className="text-xs text-zinc-600">{rooms.length} total</span>
            )}
          </div>

          {rooms.length === 0 ? (
            <EmptyRooms />
          ) : closedRooms.length === 0 && activeRooms.length > 0 ? (
            <p className="text-xs text-zinc-700">No past sessions yet.</p>
          ) : (
            <Suspense
              fallback={
                <div className="grid gap-3 sm:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-[88px] animate-pulse rounded-xl bg-zinc-900" />
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
    </div>
  );
}
