/**
 * src/components/layout/room-shell.tsx
 *
 * Dual-Device Responsive Room Shell for Watch Hub Sync.
 *
 * The shell renders one of two distinct layout modes based on the `mode` prop:
 *
 *   "primary"   (Desktop / Smart TV)
 *   ┌──────────────────────────────────┬──────────────┐
 *   │                                  │              │
 *   │     Video area (host renders     │  Sidebar:    │
 *   │     content in their own browser)│  Participants│
 *   │                                  │  + Chat      │
 *   │     Sync status overlay          │  + Controls  │
 *   │                                  │              │
 *   └──────────────────────────────────┴──────────────┘
 *
 *   "remote"    (Mobile companion screen — paired via QR)
 *   ┌──────────────┐
 *   │ Room info    │  ← compact header: title, sync status, participant count
 *   ├──────────────┤
 *   │              │
 *   │   Chat feed  │  ← full-height scrollable messages
 *   │   (scrolls)  │
 *   │              │
 *   ├──────────────┤
 *   │ Reaction bar │  ← emoji reactions + send message input
 *   └──────────────┘
 *
 * Usage:
 *   const mode = searchParams.get('mode') === 'remote' ? 'remote' : 'primary'
 *   <RoomShell mode={mode} roomId={roomId} roomTitle={title}>
 *     <RoomShell.Video>       {/* your OTT video area *\/}
 *     <RoomShell.Chat>        {/* LiveKit data channel chat *\/}
 *     <RoomShell.Participants>{/* participant roster *\/}
 *     <RoomShell.Controls>    {/* host controls *\/}
 *   </RoomShell>
 *
 * Compound component pattern — slot children are injected at named positions.
 * This keeps the layout wiring inside the shell and the content outside.
 */

"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  WifiOff,
  Users,
  MessageSquare,
  Radio,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoomMode = "primary" | "remote";

export interface SyncStatus {
  readonly isConnected: boolean;
  readonly isSynced: boolean;
  readonly driftMs: number;
  readonly participantCount: number;
}

export interface RoomShellProps {
  readonly mode: RoomMode;
  readonly roomId: string;
  readonly roomTitle?: string;
  readonly platform?: string;
  readonly syncStatus?: SyncStatus;
  readonly children?: ReactNode;
  readonly className?: string;
}

// ---------------------------------------------------------------------------
// Slot context — lets named slot components self-register
// ---------------------------------------------------------------------------

interface SlotContent {
  video: ReactNode;
  chat: ReactNode;
  participants: ReactNode;
  controls: ReactNode;
}

interface RoomShellContextValue {
  mode: RoomMode;
  syncStatus: SyncStatus;
  slots: SlotContent;
  setSlot: (key: keyof SlotContent, content: ReactNode) => void;
}

const RoomShellContext = createContext<RoomShellContextValue | null>(null);

function useRoomShell(): RoomShellContextValue {
  const ctx = useContext(RoomShellContext);
  if (ctx === null) {
    throw new Error("useRoomShell must be used inside <RoomShell>");
  }
  return ctx;
}

const DEFAULT_SYNC: SyncStatus = {
  isConnected: false,
  isSynced: false,
  driftMs: 0,
  participantCount: 0,
};

// ---------------------------------------------------------------------------
// Sync status indicator
// ---------------------------------------------------------------------------

function SyncIndicator({
  status,
  compact = false,
}: {
  status: SyncStatus;
  compact?: boolean;
}) {
  if (!status.isConnected) {
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 text-neutral-600",
          compact ? "text-2xs" : "text-xs",
        )}
        aria-live="polite"
        aria-atomic="true"
      >
        <WifiOff className="h-3 w-3 text-danger" aria-hidden="true" />
        {!compact && <span>Disconnected</span>}
      </div>
    );
  }

  const driftColor =
    status.driftMs < 500
      ? "text-ok"
      : status.driftMs < 2000
      ? "text-warn"
      : "text-danger";

  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        compact ? "text-2xs" : "text-xs",
      )}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping-soft rounded-full bg-ok opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
      </span>
      {status.isSynced ? (
        <span className={cn("font-medium", compact ? driftColor : "text-ok")}>
          {compact
            ? `${status.driftMs}ms`
            : `Synced · ${status.driftMs}ms drift`}
        </span>
      ) : (
        <span className="text-warn">Syncing…</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primary layout — widescreen
// ---------------------------------------------------------------------------

function PrimaryLayout() {
  const { slots, syncStatus } = useRoomShell();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "participants">("chat");

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Video area ──────────────────────────────────────────────────── */}
      <div
        className={cn(
          "relative flex flex-1 flex-col overflow-hidden bg-black transition-all duration-350 ease-spring",
          isSidebarCollapsed ? "mr-0" : "mr-[var(--sidebar-width)]",
        )}
      >
        {/* Video slot */}
        <div className="relative flex-1 bg-black">
          {slots.video ?? (
            <VideoPlaceholder />
          )}

          {/* Sync status overlay — top-right corner */}
          <div
            className="absolute right-4 top-4 z-10"
            aria-label="Synchronization status"
          >
            <div className="glass rounded-lg px-2.5 py-1.5">
              <SyncIndicator status={syncStatus} />
            </div>
          </div>
        </div>

        {/* Controls bar */}
        {slots.controls !== undefined && (
          <div className="border-t border-white/[0.06] bg-canvas/90 backdrop-blur-sm">
            {slots.controls}
          </div>
        )}
      </div>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        className={cn(
          "fixed right-0 top-[var(--nav-height)] flex h-[calc(100dvh-var(--nav-height))] flex-col",
          "w-[var(--sidebar-width)] bg-surface",
          "border-l border-white/[0.06]",
          "transition-transform duration-350 ease-spring",
          isSidebarCollapsed
            ? "translate-x-full"
            : "translate-x-0",
        )}
        aria-label="Room sidebar"
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          {/* Tab switcher */}
          <div className="flex items-center gap-1 rounded-lg bg-surface-raised p-1">
            {(
              [
                { id: "chat" as const, label: "Chat", icon: MessageSquare },
                { id: "participants" as const, label: "People", icon: Users },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150",
                  activeTab === id
                    ? "bg-surface-overlay text-white shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                    : "text-neutral-500 hover:text-neutral-300",
                )}
                aria-pressed={activeTab === id}
              >
                <Icon className="h-3 w-3" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          {/* Collapse toggle */}
          <button
            onClick={() => setIsSidebarCollapsed((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-white/[0.05] hover:text-white transition-colors"
            aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isSidebarCollapsed ? (
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            {activeTab === "chat" ? (
              <motion.div
                key="chat"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="h-full"
              >
                {slots.chat ?? (
                  <div className="flex h-full items-center justify-center text-xs text-neutral-700">
                    Chat not connected
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="participants"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="h-full overflow-y-auto"
              >
                {slots.participants ?? (
                  <div className="flex h-full items-center justify-center text-xs text-neutral-700">
                    No participants yet
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Participant count footer */}
        <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-2">
          <div className="flex items-center gap-1.5 text-xs text-neutral-600">
            <Users className="h-3 w-3" aria-hidden="true" />
            <span>
              {syncStatus.participantCount === 0
                ? "Waiting for guests…"
                : `${syncStatus.participantCount} watching`}
            </span>
          </div>
          <SyncIndicator status={syncStatus} compact />
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remote/companion layout — mobile
// ---------------------------------------------------------------------------

function RemoteLayout({
  roomTitle,
  platform,
}: {
  roomTitle?: string | undefined;
  platform?: string | undefined;
}) {
  const { slots, syncStatus } = useRoomShell();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Compact header */}
      <header className="flex items-center gap-3 border-b border-white/[0.06] bg-surface/80 px-4 py-3 backdrop-blur-xl safe-top">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
            {syncStatus.isConnected && (
              <span className="absolute inline-flex h-full w-full animate-ping-soft rounded-full bg-ok opacity-75" />
            )}
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                syncStatus.isConnected ? "bg-ok" : "bg-neutral-700",
              )}
            />
          </div>

          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-white">
              {roomTitle ?? "Watch Session"}
            </p>
            {platform !== undefined && (
              <p className="text-2xs text-neutral-600 capitalize">{platform}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="default" className="text-2xs">
            <Users className="h-2.5 w-2.5" aria-hidden="true" />
            {syncStatus.participantCount}
          </Badge>
          <SyncIndicator status={syncStatus} compact />
        </div>
      </header>

      {/* Chat feed — full height */}
      <div className="flex-1 overflow-hidden">
        {slots.chat ?? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <MessageSquare
              className="h-8 w-8 text-neutral-700"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-medium text-neutral-500">
                You're on the companion screen
              </p>
              <p className="mt-1 text-xs text-neutral-700">
                Chat and reactions will appear here once guests join
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Reaction bar + message input — pinned bottom */}
      <div className="safe-bottom border-t border-white/[0.06] bg-surface/90 backdrop-blur-xl">
        <ReactionBar />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reaction bar (companion screen)
// ---------------------------------------------------------------------------

const REACTIONS = ["❤️", "😂", "🔥", "👏", "😮", "🎬"] as const;

function ReactionBar() {
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    // Actual send handled by the chat hook via LiveKit data channel
    // This component emits a custom DOM event that the chat hook listens to.
    window.dispatchEvent(
      new CustomEvent("whs:send-chat", { detail: { text: trimmed } }),
    );
    setMessage("");
    inputRef.current?.focus();
  }, [message]);

  const handleReaction = useCallback((emoji: string) => {
    window.dispatchEvent(
      new CustomEvent("whs:send-reaction", { detail: { emoji } }),
    );
  }, []);

  return (
    <div className="space-y-2 p-3">
      {/* Emoji reaction strip */}
      <div
        className="flex items-center justify-around"
        role="group"
        aria-label="Quick reactions"
      >
        {REACTIONS.map((emoji) => (
          <button
            key={emoji}
            onClick={() => handleReaction(emoji)}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-lg transition-transform duration-150 hover:scale-125 active:scale-95 no-tap"
            aria-label={`React with ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Message input */}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          placeholder="Say something…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          maxLength={280}
          className={cn(
            "flex-1 rounded-xl bg-surface-raised px-4 py-2.5 text-sm text-white",
            "ring-1 ring-inset ring-white/[0.08]",
            "placeholder:text-neutral-700",
            "focus:outline-none focus:ring-2 focus:ring-accent/50",
            "transition-shadow duration-150",
          )}
          aria-label="Chat message"
        />
        <button
          onClick={handleSend}
          disabled={message.trim().length === 0}
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all duration-150",
            "bg-accent text-white",
            "disabled:opacity-30 disabled:pointer-events-none",
            "hover:bg-accent-hover active:scale-[0.95]",
          )}
          aria-label="Send message"
        >
          <svg
            className="h-4 w-4 rotate-45"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video placeholder — shown before OTT adapter attaches
// ---------------------------------------------------------------------------

function VideoPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-black text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface/60 ring-1 ring-inset ring-white/10">
        <Radio className="h-8 w-8 text-neutral-600" aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm font-medium text-neutral-400">
          Open your streaming platform in a new tab
        </p>
        <p className="mt-1 text-xs text-neutral-700">
          The sync engine will detect playback automatically
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Named slot components
// ---------------------------------------------------------------------------

function VideoSlot({ children }: { children: ReactNode }) {
  const { setSlot } = useRoomShell();
  useEffect(() => { setSlot("video", children); }, [children, setSlot]);
  return null;
}

function ChatSlot({ children }: { children: ReactNode }) {
  const { setSlot } = useRoomShell();
  useEffect(() => { setSlot("chat", children); }, [children, setSlot]);
  return null;
}

function ParticipantsSlot({ children }: { children: ReactNode }) {
  const { setSlot } = useRoomShell();
  useEffect(() => { setSlot("participants", children); }, [children, setSlot]);
  return null;
}

function ControlsSlot({ children }: { children: ReactNode }) {
  const { setSlot } = useRoomShell();
  useEffect(() => { setSlot("controls", children); }, [children, setSlot]);
  return null;
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

/**
 * RoomShell — top-level layout orchestrator.
 * Wraps the entire room experience and switches between Primary and Remote mode.
 */
function RoomShellRoot({
  mode,
  roomId: _roomId,
  roomTitle,
  platform,
  syncStatus = DEFAULT_SYNC,
  children,
  className,
}: RoomShellProps) {
  const [slots, setSlots] = useState<SlotContent>({
    video: null,
    chat: null,
    participants: null,
    controls: null,
  });

  const setSlot = useCallback(
    (key: keyof SlotContent, content: ReactNode) => {
      setSlots((prev) => ({ ...prev, [key]: content }));
    },
    [],
  );

  const contextValue: RoomShellContextValue = {
    mode,
    syncStatus,
    slots,
    setSlot,
  };

  return (
    <RoomShellContext.Provider value={contextValue}>
      <div
        className={cn(
          "relative flex h-[calc(100dvh-var(--nav-height))] flex-col overflow-hidden bg-canvas",
          className,
        )}
        data-room-mode={mode}
        aria-label={`Watch room — ${mode} device`}
      >
        {/* Mode badge — development aid, hidden in production */}
        {process.env["NODE_ENV"] === "development" && (
          <div className="absolute left-4 top-4 z-50">
            <Badge variant={mode === "primary" ? "accent" : "warning"}>
              {mode} mode
            </Badge>
          </div>
        )}

        {/* Slot registration children (rendered invisible) */}
        {children}

        {/* Layout renderer — switches based on mode */}
        <AnimatePresence mode="wait" initial={false}>
          {mode === "primary" ? (
            <motion.div
              key="primary"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="h-full"
            >
              <PrimaryLayout />
            </motion.div>
          ) : (
            <motion.div
              key="remote"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="h-full"
            >
              <RemoteLayout roomTitle={roomTitle} platform={platform} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </RoomShellContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const RoomShell = Object.assign(RoomShellRoot, {
  Video:        VideoSlot,
  Chat:         ChatSlot,
  Participants: ParticipantsSlot,
  Controls:     ControlsSlot,
});

export type {
  SyncStatus as RoomSyncStatus,
};
