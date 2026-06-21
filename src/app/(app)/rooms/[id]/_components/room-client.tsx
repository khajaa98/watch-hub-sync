"use client";

/**
 * src/app/(app)/rooms/[id]/_components/room-client.tsx
 *
 * Phase 12 — Theater Player.
 * YouTube: embedded iframe + YouTube IFrame API via postMessage.
 * Other platforms: link card (X-Frame-Options blocks embedding).
 *
 * Layout: header → video (aspect-video hero) with HUD overlay → participant strip.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  LiveKitRoom,
  useRoomContext,
  useParticipants,
  useDataChannel,
  useConnectionState,
} from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import {
  Copy,
  Check,
  Users,
  LogOut,
  Wifi,
  WifiOff,
  Loader2,
  Play,
  Pause,
  Crown,
  Radio,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RoomRow, RoomSettings } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoomClientProps {
  readonly roomId: string;
  readonly room: RoomRow;
  readonly isHost: boolean;
  readonly inviteUrl: string | null;
  readonly userId: string;
  readonly displayName: string;
}

interface SyncMessage {
  type: "play" | "pause" | "seek";
  position?: number | undefined;
  ts: number;
}

interface LastSync {
  type: string;
  at: Date;
}

// ---------------------------------------------------------------------------
// Platform config
// ---------------------------------------------------------------------------

const PLATFORM_LABELS: Record<string, string> = {
  youtube:    "YouTube",
  jiohotstar: "JioHotstar",
  netflix:    "Netflix",
  primevideo: "Prime Video",
};

const PLATFORM_BADGE: Record<string, string> = {
  youtube:    "text-red-400 bg-red-500/10 border-red-500/20",
  jiohotstar: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  netflix:    "text-red-500 bg-red-600/10 border-red-600/20",
  primevideo: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
};

const PLATFORM_URLS: Record<string, string> = {
  jiohotstar: "https://www.hotstar.com",
  netflix:    "https://www.netflix.com",
  primevideo: "https://www.primevideo.com",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractYouTubeId(value: string): string | null {
  if (value.length === 0) return null;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const m = value.match(pattern);
    if (m !== null) {
      const id = m[1];
      if (id !== undefined) return id;
    }
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  return null;
}

// ---------------------------------------------------------------------------
// YouTube Player
// ---------------------------------------------------------------------------

interface YouTubePlayerProps {
  readonly videoId: string;
  readonly iframeRef: React.RefObject<HTMLIFrameElement>;
}

function YouTubePlayer({ videoId, iframeRef }: YouTubePlayerProps) {
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://www.watchhubsync.online";

  const src = [
    `https://www.youtube.com/embed/${videoId}`,
    `?enablejsapi=1`,
    `&origin=${encodeURIComponent(origin)}`,
    `&rel=0&modestbranding=1&fs=1`,
  ].join("");

  return (
    <iframe
      ref={iframeRef}
      src={src}
      className="h-full w-full border-0"
      title="Video player"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
    />
  );
}

// ---------------------------------------------------------------------------
// Platform link card (non-embeddable)
// ---------------------------------------------------------------------------

interface PlatformLinkCardProps {
  readonly platform: string;
  readonly contentTitle: string;
  readonly contentId: string | undefined;
}

function PlatformLinkCard({ platform, contentTitle, contentId }: PlatformLinkCardProps) {
  const label  = PLATFORM_LABELS[platform] ?? platform;
  const badge  = PLATFORM_BADGE[platform] ?? "text-neutral-400 bg-white/5 border-white/10";
  const baseUrl = PLATFORM_URLS[platform] ?? `https://www.${platform}.com`;
  const href   = contentId !== undefined && contentId.startsWith("http")
    ? contentId
    : baseUrl;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 bg-zinc-900/60 px-8 text-center">
      <span className={cn("rounded-md border px-3 py-1 text-sm font-medium", badge)}>
        {label}
      </span>
      <div>
        <p className="mb-1 text-base font-semibold text-white">{contentTitle}</p>
        <p className="text-xs text-neutral-500">
          {label} cannot be embedded — open it in a separate tab and use sync controls below.
        </p>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2 text-xs text-neutral-300 transition-all hover:bg-white/[0.10]"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in {label}
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoomUI — rendered inside LiveKitRoom context
// ---------------------------------------------------------------------------

function RoomUI({
  room,
  isHost,
  inviteUrl,
  userId,
  displayName: _displayName,
}: Omit<RoomClientProps, "roomId">) {
  const router          = useRouter();
  const connectionState = useConnectionState();
  const participants    = useParticipants();
  const lkRoom          = useRoomContext();
  const iframeRef       = useRef<HTMLIFrameElement>(null);

  const [copied, setCopied]         = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [lastSync, setLastSync]     = useState<LastSync | null>(null);

  const settings = (
    typeof room.settings === "object" && room.settings !== null
      ? room.settings
      : {}
  ) as RoomSettings;

  const contentTitle  = settings.content_title ?? "Untitled Session";
  const contentId     = settings.content_id;
  const platformLabel = PLATFORM_LABELS[room.platform] ?? room.platform;
  const platformBadge = PLATFORM_BADGE[room.platform]  ?? "text-neutral-400 bg-white/5 border-white/10";

  const isYouTube = room.platform === "youtube";
  const youtubeId = isYouTube && contentId !== undefined
    ? extractYouTubeId(contentId)
    : null;

  // ── postMessage to embedded player ──────────────────────────────────────
  const sendToPlayer = useCallback((func: string, args?: unknown) => {
    const message = args !== undefined
      ? JSON.stringify({ event: "command", func, args })
      : JSON.stringify({ event: "command", func, args: "" });
    iframeRef.current?.contentWindow?.postMessage(message, "https://www.youtube.com");
  }, []);

  // ── DataChannel receive ──────────────────────────────────────────────────
  const onSyncMessage = useCallback(
    (message: { payload: Uint8Array }) => {
      try {
        const text   = new TextDecoder().decode(message.payload);
        const parsed = JSON.parse(text) as SyncMessage;
        setLastSync({ type: parsed.type, at: new Date() });

        if (parsed.type === "play")  sendToPlayer("playVideo");
        if (parsed.type === "pause") sendToPlayer("pauseVideo");
        if (parsed.type === "seek" && parsed.position !== undefined) {
          sendToPlayer("seekTo", [parsed.position, true]);
        }
      } catch {
        // ignore malformed
      }
    },
    [sendToPlayer],
  );

  useDataChannel("sync", onSyncMessage);

  // ── Broadcast sync (host only) + apply locally ──────────────────────────
  const broadcastSync = useCallback(
    (type: "play" | "pause") => {
      if (!isHost) return;
      const msg: SyncMessage = { type, ts: Date.now() };
      const encoded = new TextEncoder().encode(JSON.stringify(msg));
      void lkRoom.localParticipant.publishData(encoded, { reliable: true, topic: "sync" });
      if (type === "play")  sendToPlayer("playVideo");
      if (type === "pause") sendToPlayer("pauseVideo");
      setLastSync({ type, at: new Date() });
    },
    [isHost, lkRoom, sendToPlayer],
  );

  // ── Copy invite link ─────────────────────────────────────────────────────
  const handleCopy = useCallback(async () => {
    if (inviteUrl === null) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }, [inviteUrl]);

  // ── Leave / End ──────────────────────────────────────────────────────────
  const handleLeave = useCallback(() => {
    lkRoom.disconnect();
    router.push("/dashboard");
  }, [lkRoom, router]);

  const isConnected  = connectionState === ConnectionState.Connected;
  const isConnecting = connectionState === ConnectionState.Connecting
                    || connectionState === ConnectionState.Reconnecting;

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.05] bg-black/60 px-4 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <span className={cn(
            "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
            platformBadge,
          )}>
            {platformLabel}
          </span>
          <span className="max-w-[160px] truncate text-sm font-medium text-white sm:max-w-sm">
            {contentTitle}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Invite toggle (host only) */}
          {isHost && inviteUrl !== null && (
            <button
              type="button"
              onClick={() => setShowInvite((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-400 transition-colors hover:bg-violet-500/20"
            >
              <Users className="h-3.5 w-3.5" />
              Invite
            </button>
          )}

          {/* Live badge */}
          <span className={cn(
            "flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium",
            isConnected  ? "bg-emerald-500/10 text-emerald-400"
            : isConnecting ? "bg-yellow-500/10 text-yellow-400"
            : "bg-red-500/10 text-red-400",
          )}>
            {isConnecting ? <Loader2 className="h-3 w-3 animate-spin" />
              : isConnected ? <Wifi className="h-3 w-3" />
              : <WifiOff className="h-3 w-3" />}
            {isConnecting ? "Connecting" : isConnected ? "Live" : "Offline"}
          </span>

          {/* Leave / End */}
          <button
            type="button"
            onClick={handleLeave}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <LogOut className="h-3.5 w-3.5" />
            {isHost ? "End Room" : "Leave"}
          </button>
        </div>
      </header>

      {/* ── Invite strip (collapsible) ───────────────────────────────────── */}
      {showInvite && inviteUrl !== null && (
        <div className="border-b border-white/[0.05] bg-black/50 px-4 py-2.5 backdrop-blur-md">
          <div className="mx-auto flex max-w-4xl items-center gap-2">
            <code className="flex-1 truncate rounded border border-white/[0.06] bg-black/30 px-3 py-1.5 text-xs text-neutral-400">
              {inviteUrl}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="flex shrink-0 items-center gap-1.5 rounded border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-neutral-300 transition-all hover:bg-white/[0.08]"
            >
              {copied
                ? <Check className="h-3.5 w-3.5 text-emerald-400" />
                : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* ── Theater ─────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-4">
        <div className="w-full max-w-5xl">

          {/* Video + HUD */}
          <div
            className="relative w-full overflow-hidden rounded-xl bg-black shadow-2xl"
            style={{ aspectRatio: "16 / 9" }}
          >
            {isYouTube && youtubeId !== null ? (
              <YouTubePlayer videoId={youtubeId} iframeRef={iframeRef} />
            ) : (
              <PlatformLinkCard
                platform={room.platform}
                contentTitle={contentTitle}
                contentId={contentId}
              />
            )}

            {/* HUD overlay */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-4 pb-4 pt-12">
              <div className="pointer-events-auto flex items-center justify-between gap-3">

                {/* Left: participant count */}
                <div className="flex items-center gap-1.5 text-xs text-white/60">
                  <Radio className="h-3 w-3 text-emerald-400" />
                  {participants.length} connected
                </div>

                {/* Center: controls */}
                <div className="flex items-center gap-2">
                  {isHost ? (
                    <>
                      <button
                        type="button"
                        onClick={() => broadcastSync("play")}
                        disabled={!isConnected}
                        className="flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-300 backdrop-blur-sm transition-all hover:bg-emerald-500/35 disabled:opacity-40"
                      >
                        <Play className="h-4 w-4 fill-current" />
                        Play All
                      </button>
                      <button
                        type="button"
                        onClick={() => broadcastSync("pause")}
                        disabled={!isConnected}
                        className="flex items-center gap-1.5 rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-white/80 backdrop-blur-sm transition-all hover:bg-white/20 disabled:opacity-40"
                      >
                        <Pause className="h-4 w-4 fill-current" />
                        Pause All
                      </button>
                    </>
                  ) : (
                    lastSync !== null ? (
                      <div className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs text-white/60 backdrop-blur-sm">
                        {lastSync.type === "play"
                          ? <Play  className="h-3 w-3 fill-current text-emerald-400" />
                          : <Pause className="h-3 w-3 fill-current text-yellow-400" />}
                        Synced · {lastSync.at.toLocaleTimeString()}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-white/40">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Waiting for host…
                      </div>
                    )
                  )}
                </div>

                {/* Right: last sync time */}
                <div className="text-xs text-white/30">
                  {lastSync !== null ? lastSync.at.toLocaleTimeString() : ""}
                </div>
              </div>
            </div>
          </div>

          {/* Participant chips */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {participants.map((p) => {
              const isMe           = p.identity.startsWith(userId);
              const identityPrefix = p.identity.split(":")[0];
              const name           = p.name ?? identityPrefix ?? "Guest";
              return (
                <div
                  key={p.identity}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                    isMe
                      ? "border-violet-500/30 bg-violet-500/10 text-violet-300"
                      : "border-white/[0.07] bg-white/[0.02] text-neutral-500",
                  )}
                >
                  {isMe && isHost && <Crown className="h-3 w-3 text-yellow-400" />}
                  <Radio className={cn("h-2 w-2", isMe ? "text-emerald-400" : "text-emerald-700")} />
                  {name}{isMe ? " (you)" : ""}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoomClient — fetches LiveKit token, then renders LiveKitRoom + RoomUI
// ---------------------------------------------------------------------------

export function RoomClient(props: RoomClientProps) {
  const { roomId } = props;
  const [token,      setToken]      = useState<string | null>(null);
  const [livekitUrl, setLivekitUrl] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/room/${roomId}/token`);
        if (!res.ok) {
          const body = await res.json() as { error?: string };
          setTokenError(body.error ?? `Token request failed (${res.status})`);
          return;
        }
        const data = await res.json() as { token: string; livekitUrl: string };
        setToken(data.token);
        setLivekitUrl(data.livekitUrl);
      } catch {
        setTokenError("Failed to connect. Please refresh.");
      }
    })();
  }, [roomId]);

  if (tokenError !== null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950">
        <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.06] p-8 text-center">
          <WifiOff className="mx-auto mb-3 h-8 w-8 text-red-400" />
          <p className="text-sm font-medium text-red-400">{tokenError}</p>
        </div>
      </div>
    );
  }

  if (token === null || livekitUrl === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
          <p className="text-sm text-neutral-500">Connecting to room…</p>
        </div>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={livekitUrl}
      connect={true}
      audio={false}
      video={false}
      data-lk-theme="default"
    >
      <RoomUI {...props} />
    </LiveKitRoom>
  );
}
