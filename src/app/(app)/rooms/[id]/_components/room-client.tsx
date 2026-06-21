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
import QRCode from "qrcode";
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
  X,
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
  QrCode,
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
  type: "play" | "pause" | "seek" | "SYNC_STATE";
  position?: number | undefined;
  /** heartbeat only */
  isPlaying?: boolean | undefined;
  /** heartbeat only — host's currentTime at broadcast */
  currentTime?: number | undefined;
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

/**
 * Extract the 11-character YouTube video ID from any common URL format:
 *   https://www.youtube.com/watch?v=ID
 *   https://youtu.be/ID
 *   https://www.youtube.com/embed/ID
 *   https://www.youtube.com/shorts/ID
 *   ID  (bare 11-char alphanumeric)
 */
function extractYouTubeId(value: string): string | null {
  if (value.length === 0) return null;
  // Single consolidated regex — first capture group is always the 11-char ID.
  const m = value.match(
    /(?:[?&]v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|v)\/)([A-Za-z0-9_-]{11})/,
  );
  if (m !== null) {
    const id = m[1];
    if (id !== undefined) return id;
  }
  // Bare ID fallback
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  return null;
}

/**
 * Build a safe YouTube embed URL from any raw input.
 * Returns null if no valid 11-char ID can be extracted.
 *
 * The `origin` parameter tells YouTube which page is allowed to send
 * postMessage commands — required for seekTo/playVideo to be accepted.
 */
function getYouTubeEmbedUrl(raw: string): string | null {
  const id = extractYouTubeId(raw);
  if (id === null) return null;
  const origin =
    typeof window !== "undefined"
      ? `&origin=${encodeURIComponent(window.location.origin)}`
      : "";
  return `https://www.youtube.com/embed/${id}?enablejsapi=1${origin}&rel=0&modestbranding=1&fs=1`;
}

// ---------------------------------------------------------------------------
// YouTube Player
// ---------------------------------------------------------------------------

interface YouTubePlayerProps {
  readonly embedUrl: string;
  readonly iframeRef: React.RefObject<HTMLIFrameElement>;
  readonly onLoad?: () => void;
}

function YouTubePlayer({ embedUrl, iframeRef, onLoad }: YouTubePlayerProps) {
  return (
    <iframe
      key={embedUrl}
      ref={iframeRef}
      src={embedUrl}
      onLoad={onLoad}
      className="h-full w-full border-0"
      title="YouTube video player"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      sandbox="allow-same-origin allow-scripts allow-presentation allow-forms"
      allowFullScreen
    />
  );
}

function InvalidVideoLink() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-red-500/40 bg-red-500/[0.06] px-8 text-center">
      <span className="text-2xl">⚠️</span>
      <p className="text-sm font-semibold text-red-400">Invalid Video Link</p>
      <p className="text-xs text-red-400/70">
        Please check the URL — it must be a valid youtube.com or youtu.be link.
      </p>
    </div>
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
// InviteModal — persistent QR + copy dialog (host only)
// ---------------------------------------------------------------------------

interface InviteModalProps {
  readonly inviteUrl: string;
  readonly onClose: () => void;
}

function InviteModal({ inviteUrl, onClose }: InviteModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied]       = useState(false);

  useEffect(() => {
    QRCode.toDataURL(inviteUrl, {
      width: 220,
      margin: 2,
      color: { dark: "#FAFAFA", light: "#111111" },
      errorCorrectionLevel: "M",
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [inviteUrl]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }, [inviteUrl]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-zinc-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <QrCode className="h-4 w-4 text-violet-400" />
            <span className="text-sm font-semibold text-white">Invite Guests</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* QR code */}
        <div className="mb-4 flex justify-center">
          <div className="rounded-xl bg-[#111] p-3 ring-1 ring-white/[0.06]">
            {qrDataUrl !== null ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="Scan to join"
                width={180}
                height={180}
                className="rounded-lg"
                style={{ imageRendering: "pixelated" }}
              />
            ) : (
              <div className="h-[180px] w-[180px] animate-pulse rounded-lg bg-zinc-800" />
            )}
          </div>
        </div>

        {/* Hint */}
        <p className="mb-4 text-center text-xs text-neutral-500">
          Scan with a phone/tablet · Link expires in 48 hours
        </p>

        {/* Copy row */}
        <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-black/30 px-3 py-2">
          <code className="flex-1 truncate text-xs text-neutral-400">
            {inviteUrl}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.05] px-3 py-1.5 text-xs text-neutral-300 transition-all hover:bg-white/[0.10]"
          >
            {copied
              ? <Check className="h-3.5 w-3.5 text-emerald-400" />
              : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoomUI — rendered inside LiveKitRoom context
// ---------------------------------------------------------------------------

function RoomUI({
  roomId,
  room,
  isHost,
  inviteUrl: initialInviteUrl,
  userId,
  displayName: _displayName,
}: RoomClientProps) {
  const router          = useRouter();
  const connectionState = useConnectionState();
  const participants    = useParticipants();
  const lkRoom          = useRoomContext();
  const iframeRef          = useRef<HTMLIFrameElement>(null);
  /** YouTube currentTime, updated by infoDelivery postMessages (~250ms) */
  const currentTimeRef     = useRef<number>(0);
  /**
   * YouTube playerState from infoDelivery:
   *   -1 = unstarted, 0 = ended, 1 = playing, 2 = paused, 3 = buffering
   */
  const playerStateRef     = useRef<number>(-1);
  /** True once the guest has clicked the unlock overlay (or if they're the host) */
  const playerUnlockedRef  = useRef<boolean>(isHost);
  /** Buffered seek position waiting for guest unlock click */
  const pendingSeekRef     = useRef<number | undefined>(undefined);

  const [showInviteModal,   setShowInviteModal]   = useState(false);
  const [liveInviteUrl,     setLiveInviteUrl]     = useState<string | null>(initialInviteUrl);
  const [isFetchingInvite,  setIsFetchingInvite]  = useState(false);
  const [lastSync,          setLastSync]           = useState<LastSync | null>(null);
  /** Guest-only: show "Click to join sync" overlay when autoplay is blocked */
  const [needsInteraction,  setNeedsInteraction]  = useState(false);

  const settings = (
    typeof room.settings === "object" && room.settings !== null
      ? room.settings
      : {}
  ) as RoomSettings;

  const contentTitle  = settings.content_title ?? "Untitled Session";
  const contentId     = settings.content_id;
  const platformLabel = PLATFORM_LABELS[room.platform] ?? room.platform;
  const platformBadge = PLATFORM_BADGE[room.platform]  ?? "text-neutral-400 bg-white/5 border-white/10";

  const isYouTube   = room.platform === "youtube";
  const embedUrl    = isYouTube && contentId !== undefined
    ? getYouTubeEmbedUrl(contentId)
    : null;
  const youtubeReady = isYouTube && embedUrl !== null;

  // ── Initialize YouTube IFrame API channel ────────────────────────────────
  // YouTube only processes seekTo/playVideo commands AFTER receiving a
  // "listening" handshake from the parent page. Without this, all our
  // postMessage commands are silently dropped.
  const handleIframeLoad = useCallback(() => {
    console.log("[WHS] iframe loaded — sending YouTube API listening handshake");
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
      "https://www.youtube.com",
    );
  }, []);

  // ── Track YouTube state via postMessage events ────────────────────────────
  // infoDelivery   → {event:"infoDelivery", info:{currentTime, playerState}}
  // onStateChange  → {event:"onStateChange", info: <number>}   ← info IS the state
  // playerState values: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering
  useEffect(() => {
    const handler = (event: MessageEvent<unknown>) => {
      if (event.origin !== "https://www.youtube.com") return;
      try {
        const data = JSON.parse(event.data as string) as {
          event?: string;
          info?: number | { currentTime?: number; playerState?: number };
        };

        // State changes come as a bare number in info
        if (data.event === "onStateChange" && typeof data.info === "number") {
          playerStateRef.current = data.info;
          console.log("[WHS] YT playerState →", data.info,
            data.info === 1 ? "(playing)" : data.info === 2 ? "(paused)" : "");
        }

        // Periodic delivery while playing — currentTime and playerState
        if (
          data.event === "infoDelivery" &&
          typeof data.info === "object" &&
          data.info !== null
        ) {
          if (typeof data.info.currentTime === "number") {
            currentTimeRef.current = data.info.currentTime;
          }
          if (typeof data.info.playerState === "number") {
            playerStateRef.current = data.info.playerState;
          }
        }
      } catch { /* ignore malformed */ }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

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

        // ── Heartbeat: state-reconciliation (host → all guests every 2s) ───
        if (parsed.type === "SYNC_STATE") {
          const hostTime     = parsed.currentTime ?? 0;
          const hostPlaying  = parsed.isPlaying === true;
          const guestTime    = currentTimeRef.current;
          const guestPlaying = playerStateRef.current === 1; // 1 = YT playing
          const diff         = Math.abs(hostTime - guestTime);

          console.log("[WHS] SYNC_STATE →", {
            hostTime: hostTime.toFixed(2),
            guestTime: guestTime.toFixed(2),
            diff: diff.toFixed(2),
            hostPlaying,
            guestPlaying,
          });

          // Deadband: only seek if drift ≥ 1.0s to avoid micro-stuttering
          if (diff >= 1.0) {
            console.log("[WHS] Syncing to host:", hostTime.toFixed(2), "(was:", guestTime.toFixed(2), ")");
            sendToPlayer("seekTo", [hostTime, true]);
            // Note: do NOT update currentTimeRef here — only trust actual
            // infoDelivery/onStateChange events so drift is recalculated honestly.
          }

          // Play enforcer
          if (hostPlaying && !guestPlaying) {
            if (!playerUnlockedRef.current) {
              pendingSeekRef.current = hostTime;
              setNeedsInteraction(true);
            } else {
              sendToPlayer("playVideo");
            }
          }

          // Pause enforcer
          if (!hostPlaying && guestPlaying) {
            sendToPlayer("pauseVideo");
          }

          setLastSync({ type: hostPlaying ? "play" : "pause", at: new Date() });
          return;
        }

        // ── One-shot play / pause / seek ────────────────────────────────────
        setLastSync({ type: parsed.type, at: new Date() });

        // Time-correction: snap to host's position if drift > 2 seconds
        if (parsed.position !== undefined) {
          const drift = Math.abs(parsed.position - currentTimeRef.current);
          if (drift > 2) {
            sendToPlayer("seekTo", [parsed.position, true]);
          }
        }

        if (parsed.type === "play") {
          if (!playerUnlockedRef.current) {
            // Buffer the target position; show overlay so user can unlock
            pendingSeekRef.current = parsed.position;
            setNeedsInteraction(true);
          } else {
            sendToPlayer("playVideo");
          }
        }
        if (parsed.type === "pause") {
          setNeedsInteraction(false);
          sendToPlayer("pauseVideo");
        }
        if (parsed.type === "seek" && parsed.position !== undefined) {
          sendToPlayer("seekTo", [parsed.position, true]);
        }
      } catch { /* ignore malformed */ }
    },
    [sendToPlayer],
  );

  useDataChannel("sync", onSyncMessage);

  // ── Broadcast sync (host only) + apply locally ──────────────────────────
  const broadcastSync = useCallback(
    (type: "play" | "pause") => {
      if (!isHost) return;
      const position = currentTimeRef.current;
      const msg: SyncMessage = position > 0
        ? { type, position, ts: Date.now() }
        : { type, ts: Date.now() };
      const encoded = new TextEncoder().encode(JSON.stringify(msg));
      void lkRoom.localParticipant.publishData(encoded, { reliable: true, topic: "sync" });
      if (type === "play")  sendToPlayer("playVideo");
      if (type === "pause") sendToPlayer("pauseVideo");
      setLastSync({ type, at: new Date() });
    },
    [isHost, lkRoom, sendToPlayer],
  );

  // ── Heartbeat: broadcast SYNC_STATE every 2s (host only) ────────────────
  // Fires unconditionally — guests reconcile both play AND pause state.
  // Uses playerStateRef so manual in-player pause/play is reflected too.
  useEffect(() => {
    if (!isHost) return;
    const interval = setInterval(() => {
      const msg: SyncMessage = {
        type: "SYNC_STATE",
        isPlaying: playerStateRef.current === 1,
        currentTime: currentTimeRef.current,
        ts: Date.now(),
      };
      const encoded = new TextEncoder().encode(JSON.stringify(msg));
      void lkRoom.localParticipant.publishData(encoded, { reliable: false, topic: "sync" });
    }, 2000);
    return () => clearInterval(interval);
  }, [isHost, lkRoom]);

  // ── Persistent invite: fetch/rotate token on demand ─────────────────────
  const handleInviteClick = useCallback(async () => {
    if (liveInviteUrl !== null) {
      setShowInviteModal(true);
      return;
    }
    setIsFetchingInvite(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/invite`, { method: "POST" });
      if (res.ok) {
        const { inviteUrl: url } = await res.json() as { inviteUrl: string };
        setLiveInviteUrl(url);
        setShowInviteModal(true);
      }
    } finally {
      setIsFetchingInvite(false);
    }
  }, [liveInviteUrl, roomId]);

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
          {/* Invite button — always visible for host; fetches URL on demand */}
          {isHost && (
            <button
              type="button"
              onClick={() => void handleInviteClick()}
              disabled={isFetchingInvite}
              className="flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-400 transition-colors hover:bg-violet-500/20 disabled:opacity-50"
            >
              {isFetchingInvite
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Users className="h-3.5 w-3.5" />}
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

      {/* ── Invite modal (portal) ───────────────────────────────────────── */}
      {showInviteModal && liveInviteUrl !== null && (
        <InviteModal
          inviteUrl={liveInviteUrl}
          onClose={() => setShowInviteModal(false)}
        />
      )}

      {/* ── Theater ─────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-4">
        <div className="w-full max-w-5xl">

          {/* Video + HUD */}
          <div
            className="relative w-full overflow-hidden rounded-xl bg-black shadow-2xl"
            style={{ aspectRatio: "16 / 9" }}
          >
            {youtubeReady && embedUrl !== null ? (
              <YouTubePlayer embedUrl={embedUrl} iframeRef={iframeRef} onLoad={handleIframeLoad} />
            ) : isYouTube ? (
              <InvalidVideoLink />
            ) : (
              <PlatformLinkCard
                platform={room.platform}
                contentTitle={contentTitle}
                contentId={contentId}
              />
            )}

            {/* Guest autoplay-unlock overlay — shown when browser blocks playVideo() */}
            {!isHost && needsInteraction && (
              <button
                type="button"
                onClick={() => {
                  playerUnlockedRef.current = true;
                  setNeedsInteraction(false);
                  // Apply buffered seek position so guest starts at host's timestamp
                  if (pendingSeekRef.current !== undefined) {
                    sendToPlayer("seekTo", [pendingSeekRef.current, true]);
                    pendingSeekRef.current = undefined;
                  }
                  sendToPlayer("playVideo");
                }}
                className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/65 backdrop-blur-sm"
                aria-label="Click to join sync and start playback"
              >
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white/10 ring-2 ring-white/25 transition-transform hover:scale-105">
                  <Play className="h-9 w-9 translate-x-0.5 fill-white text-white" />
                </div>
                <span className="text-sm font-medium text-white/80">
                  Click to join sync
                </span>
                <span className="text-xs text-white/40">
                  Browser requires a tap before video can play
                </span>
              </button>
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
