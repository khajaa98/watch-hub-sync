"use client";

/**
 * src/app/(app)/rooms/[id]/_components/room-client.tsx
 *
 * LiveKit-connected room shell.
 * Fetches a token from GET /api/room/[id]/token, connects to LiveKit
 * (data-channel only — no audio/video), and renders the host dashboard.
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
import { ConnectionState, type DataPacket_Kind } from "livekit-client";
import {
  Copy,
  Check,
  Radio,
  Users,
  LogOut,
  Wifi,
  WifiOff,
  Loader2,
  Play,
  Pause,
  RefreshCw,
  Crown,
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

type SyncMessageType = "play" | "pause" | "seek";

interface SyncMessage {
  type: SyncMessageType;
  position?: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Platform labels
// ---------------------------------------------------------------------------

const PLATFORM_LABELS: Record<string, string> = {
  youtube:    "YouTube",
  jiohotstar: "JioHotstar",
  netflix:    "Netflix",
  primevideo: "Prime Video",
};

const PLATFORM_COLORS: Record<string, string> = {
  youtube:    "text-red-400 bg-red-500/10 border-red-500/20",
  jiohotstar: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  netflix:    "text-red-500 bg-red-600/10 border-red-600/20",
  primevideo: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
};

// ---------------------------------------------------------------------------
// Inner room UI — rendered inside LiveKitRoom context
// ---------------------------------------------------------------------------

function RoomUI({
  room,
  isHost,
  inviteUrl,
  userId,
  displayName,
}: Omit<RoomClientProps, "roomId">) {
  const router            = useRouter();
  const connectionState   = useConnectionState();
  const participants      = useParticipants();
  const lkRoom            = useRoomContext();
  const [copied, setCopied]             = useState(false);
  const [syncState, setSyncState]       = useState<SyncMessage | null>(null);
  const [lastSyncAt, setLastSyncAt]     = useState<Date | null>(null);

  const settings = (
    typeof room.settings === "object" && room.settings !== null
      ? room.settings
      : {}
  ) as RoomSettings;

  const contentTitle = settings.content_title ?? "Untitled Session";
  const platformLabel = PLATFORM_LABELS[room.platform] ?? room.platform;
  const platformColor = PLATFORM_COLORS[room.platform] ?? "text-neutral-400 bg-white/5 border-white/10";

  // ── DataChannel receive ────────────────────────────────────────────────────
  useDataChannel(undefined, (message) => {
    try {
      const decoded = new TextDecoder().decode(message.payload);
      const parsed = JSON.parse(decoded) as SyncMessage;
      setSyncState(parsed);
      setLastSyncAt(new Date());
    } catch {
      // ignore malformed messages
    }
  });

  // ── Send sync event ────────────────────────────────────────────────────────
  const sendSync = useCallback(
    (type: SyncMessageType, position?: number) => {
      if (!isHost) return;
      const msg: SyncMessage = { type, position, ts: Date.now() };
      const encoded = new TextEncoder().encode(JSON.stringify(msg));
      void lkRoom.localParticipant.publishData(encoded, { reliable: true });
      setSyncState(msg);
      setLastSyncAt(new Date());
    },
    [isHost, lkRoom],
  );

  // ── Copy invite link ───────────────────────────────────────────────────────
  const handleCopy = useCallback(async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API not available
    }
  }, [inviteUrl]);

  // ── Leave / End room ──────────────────────────────────────────────────────
  const handleLeave = useCallback(() => {
    lkRoom.disconnect();
    router.push("/dashboard");
  }, [lkRoom, router]);

  const isConnected = connectionState === ConnectionState.Connected;
  const isConnecting = connectionState === ConnectionState.Connecting || connectionState === ConnectionState.Reconnecting;
  const guestCount = participants.length; // includes local participant

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.06] bg-black/40 px-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          {/* Platform badge */}
          <span className={cn(
            "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium",
            platformColor,
          )}>
            {platformLabel}
          </span>
          <span className="max-w-[200px] truncate text-sm font-medium text-white sm:max-w-xs">
            {contentTitle}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Connection status pill */}
          <span className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
            isConnected
              ? "bg-emerald-500/10 text-emerald-400"
              : isConnecting
              ? "bg-yellow-500/10 text-yellow-400"
              : "bg-red-500/10 text-red-400",
          )}>
            {isConnecting
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : isConnected
              ? <Wifi className="h-3 w-3" />
              : <WifiOff className="h-3 w-3" />
            }
            {isConnecting ? "Connecting" : isConnected ? "Live" : "Disconnected"}
          </span>

          <button
            type="button"
            onClick={handleLeave}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <LogOut className="h-3.5 w-3.5" />
            {isHost ? "End Room" : "Leave"}
          </button>
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">
        <div className="flex flex-col gap-4">

          {/* Participants card */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-neutral-500" />
                <span className="text-xs font-medium uppercase tracking-widest text-neutral-500">
                  Participants
                </span>
              </div>
              <span className="text-xs text-neutral-600">{guestCount} connected</span>
            </div>

            <div className="flex flex-wrap gap-2">
              {participants.map((p) => {
                const isMe = p.identity.startsWith(userId);
                const name = p.name ?? p.identity.split(":")[0] ?? "Guest";
                const isRoomHost = p.permissions?.canPublishData === true && isHost && isMe;
                return (
                  <div
                    key={p.identity}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs",
                      isMe
                        ? "border-violet-500/30 bg-violet-500/10 text-violet-300"
                        : "border-white/[0.08] bg-white/[0.03] text-neutral-400",
                    )}
                  >
                    {isRoomHost && <Crown className="h-3 w-3 text-yellow-400" />}
                    <Radio className={cn("h-2.5 w-2.5", isMe ? "text-emerald-400" : "text-emerald-500")} />
                    <span>{name}{isMe ? " (you)" : ""}</span>
                  </div>
                );
              })}

              {guestCount === 0 && (
                <p className="text-xs text-neutral-700">Waiting for participants to join…</p>
              )}
            </div>
          </div>

          {/* Invite link card — host only */}
          {isHost && inviteUrl !== null && (
            <div className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.04] p-5">
              <div className="mb-3 flex items-center gap-2">
                <Users className="h-4 w-4 text-violet-400" />
                <span className="text-xs font-medium uppercase tracking-widest text-violet-400">
                  Invite Link
                </span>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 text-xs text-neutral-400">
                  {inviteUrl}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-neutral-300 transition-all hover:bg-white/[0.08]"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {/* Sync controls — host only */}
          {isHost && (
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="mb-4 flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-neutral-500" />
                <span className="text-xs font-medium uppercase tracking-widest text-neutral-500">
                  Sync Controls
                </span>
              </div>

              <p className="mb-4 text-xs text-neutral-600">
                Open {platformLabel} in another tab, start your content, then use these controls to sync all guests.
              </p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => sendSync("play")}
                  disabled={!isConnected}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-400 transition-all hover:bg-emerald-500/20 disabled:pointer-events-none disabled:opacity-40"
                >
                  <Play className="h-4 w-4 fill-current" />
                  Send Play
                </button>
                <button
                  type="button"
                  onClick={() => sendSync("pause")}
                  disabled={!isConnected}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3 text-sm font-medium text-yellow-400 transition-all hover:bg-yellow-500/20 disabled:pointer-events-none disabled:opacity-40"
                >
                  <Pause className="h-4 w-4 fill-current" />
                  Send Pause
                </button>
              </div>

              {syncState !== null && lastSyncAt !== null && (
                <p className="mt-3 text-xs text-neutral-600">
                  Last signal: <span className="text-neutral-400">{syncState.type}</span>{" "}
                  at {lastSyncAt.toLocaleTimeString()}
                </p>
              )}
            </div>
          )}

          {/* Guest sync status */}
          {!isHost && (
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
              <div className="mb-3 flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-neutral-500" />
                <span className="text-xs font-medium uppercase tracking-widest text-neutral-500">
                  Sync Status
                </span>
              </div>
              <p className="mb-2 text-xs text-neutral-600">
                Open {platformLabel} in another tab and wait for the host to send a sync signal.
              </p>
              {syncState !== null && lastSyncAt !== null ? (
                <div className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
                  syncState.type === "play"
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                    : "border-yellow-500/20 bg-yellow-500/10 text-yellow-400",
                )}>
                  {syncState.type === "play"
                    ? <Play className="h-3.5 w-3.5 fill-current" />
                    : <Pause className="h-3.5 w-3.5 fill-current" />
                  }
                  Host sent <strong>{syncState.type}</strong> at {lastSyncAt.toLocaleTimeString()}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-neutral-700">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Waiting for host signal…
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token fetcher wrapper
// ---------------------------------------------------------------------------

export function RoomClient(props: RoomClientProps) {
  const { roomId, displayName } = props;
  const [token, setToken]       = useState<string | null>(null);
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
        <div className="flex flex-col items-center gap-3 text-center">
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
      style={{ height: "100dvh" }}
    >
      <RoomUI {...props} />
    </LiveKitRoom>
  );
}
