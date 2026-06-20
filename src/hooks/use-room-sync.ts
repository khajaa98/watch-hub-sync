/**
 * src/hooks/use-room-sync.ts
 *
 * useRoomSync — The Core Real-Time Synchronization Hook.
 *
 * Manages the full lifecycle of a LiveKit WebRTC connection for a Watch Hub
 * Sync room. This hook is the single source of truth for real-time state.
 *
 * Architecture:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  useRoomSync                                                  │
 *   │                                                              │
 *   │  Phase 1: Token fetch (GET /api/room/:id/token)             │
 *   │  Phase 2: Room.connect() with retry/backoff                 │
 *   │  Phase 3: DataChannel subscription (RoomEvent.DataReceived) │
 *   │  Phase 4: Drift calculation on each incoming event          │
 *   │  Phase 5: Token refresh 15 min before expiry                │
 *   │  Phase 6: Graceful disconnect on unmount                    │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * DataChannel payload contract:
 *
 *   All messages are UTF-8 JSON encoded SyncEnvelope objects.
 *   The schema is defined in this file and is the sole wire format.
 *   The hook rejects any message that fails runtime schema validation.
 *
 * Reconnection strategy:
 *
 *   LiveKit's client SDK handles WebRTC ICE restarts automatically.
 *   This hook adds an application-layer retry for the initial connect
 *   phase (token fetch + Room.connect) with truncated exponential backoff:
 *     attempt 1: immediate
 *     attempt 2: 1s
 *     attempt 3: 2s
 *     attempt 4: 4s
 *     attempt 5+: 8s (cap)
 *
 * Drift calculation:
 *
 *   Each SyncEnvelope carries a `sentAt` Unix ms timestamp from the
 *   sender. On receipt, the hook computes:
 *     networkRoundTrip ≈ (Date.now() - sentAt)    [one-way approximation]
 *   This is exposed as `driftMs` for the UI to display in RoomShell.
 *
 * ZERO-PROXY GUARANTEE:
 *   This hook publishes ONLY timestamped playback-state signals via
 *   LiveKit DataChannels. It never touches, buffers, or retransmits
 *   any video or audio data.
 */

"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type RefObject,
} from "react";
import {
  Room,
  RoomEvent,
  ConnectionState,
  type RemoteParticipant,
} from "livekit-client";
import { createLogger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Wire-format types — must be kept in sync with server and adapters
// ---------------------------------------------------------------------------

/** Actions the sync engine can signal over the DataChannel. */
export type SyncAction = "play" | "pause" | "seek";

/**
 * The canonical DataChannel message envelope.
 * All fields are required — partial payloads are silently dropped.
 */
export interface SyncEnvelope {
  /** Discriminator for the playback action. */
  readonly action: SyncAction;
  /** Playback position in fractional seconds at the time of dispatch. */
  readonly timestamp: number;
  /** `Date.now()` (ms) at the moment the sender dispatched this event. */
  readonly sentAt: number;
  /** Supabase room UUID — allows multi-room tab scenarios to demux. */
  readonly roomId: string;
  /** LiveKit participant identity of the sender. */
  readonly senderId: string;
}

// ---------------------------------------------------------------------------
// Hook API types
// ---------------------------------------------------------------------------

export type RoomConnectionState =
  | "idle"         // Hook just mounted, not yet fetching token
  | "fetching"     // Getting token from /api/room/:id/token
  | "connecting"   // Room.connect() in flight
  | "connected"    // WebRTC session established
  | "reconnecting" // Lost connection, SDK is retrying ICE
  | "failed"       // All retries exhausted
  | "disconnected"; // Cleanly disconnected (unmount)

/** Callback fired when a validated sync event arrives from a remote peer. */
export type SyncEventHandler = (
  event: SyncEnvelope,
  sender: RemoteParticipant,
) => void;

export interface UseRoomSyncOptions {
  readonly roomId: string;
  /** Called whenever a validated SyncEnvelope arrives from a remote peer. */
  readonly onSyncEvent?: SyncEventHandler;
  /**
   * Maximum number of reconnect attempts before entering 'failed' state.
   * Defaults to 5.
   */
  readonly maxRetries?: number;
  /**
   * If true, this participant is the room host and is allowed to publish
   * authoritative sync commands. Guests still publish their own play/pause
   * events but the host signal takes precedence in the UI.
   */
  readonly isHost?: boolean;
}

export interface UseRoomSyncReturn {
  readonly connectionState: RoomConnectionState;
  /**
   * Publish a playback sync event to all room participants.
   * Resolves once the DataChannel message is handed to LiveKit.
   * Throws if the room is not connected.
   */
  readonly publishSyncEvent: (
    action: SyncAction,
    timestamp: number,
  ) => Promise<void>;
  /**
   * Latest one-way network latency approximation (ms) derived from
   * the most recently received SyncEnvelope's `sentAt` field.
   * Zero until the first message is received.
   */
  readonly driftMs: number;
  /**
   * Number of connected participants (excluding self).
   */
  readonly remoteParticipantCount: number;
  /**
   * Imperatively disconnect the room (e.g., when the user leaves early).
   * Safe to call even if not connected.
   */
  readonly disconnect: () => Promise<void>;
  /**
   * Ref to the underlying LiveKit Room instance for advanced use cases.
   * Treat as read-only from the consumer.
   */
  readonly roomRef: RefObject<Room | null>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TokenResponse {
  readonly token: string;
  readonly livekitUrl: string;
  readonly identity: string;
  readonly roomName: string;
  readonly refreshAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES_DEFAULT = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS  = 8_000;
const TEXT_ENCODER   = new TextEncoder();
const TEXT_DECODER   = new TextDecoder();

const log = createLogger({ module: "hooks/use-room-sync" });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function backoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 2), BACKOFF_CAP_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runtime type guard for SyncEnvelope.
 * Rejects unexpected messages that happen to arrive on the DataChannel.
 */
function isSyncEnvelope(value: unknown): value is SyncEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  return (
    (v["action"] === "play" ||
      v["action"] === "pause" ||
      v["action"] === "seek") &&
    typeof v["timestamp"] === "number" &&
    Number.isFinite(v["timestamp"]) &&
    v["timestamp"] >= 0 &&
    typeof v["sentAt"] === "number" &&
    typeof v["roomId"] === "string" &&
    typeof v["senderId"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRoomSync({
  roomId,
  onSyncEvent,
  maxRetries = MAX_RETRIES_DEFAULT,
  isHost = false,
}: UseRoomSyncOptions): UseRoomSyncReturn {
  // ── State ────────────────────────────────────────────────────────────────
  const [connectionState, setConnectionState] =
    useState<RoomConnectionState>("idle");
  const [driftMs, setDriftMs] = useState(0);
  const [remoteParticipantCount, setRemoteParticipantCount] = useState(0);

  // ── Refs — mutable without triggering re-render ──────────────────────────
  const roomRef     = useRef<Room | null>(null);
  const tokenRef    = useRef<TokenResponse | null>(null);
  const abortRef    = useRef<AbortController>(new AbortController());
  const retryRef    = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep callback ref stable across re-renders
  const onSyncEventRef = useRef<SyncEventHandler | undefined>(onSyncEvent);
  useEffect(() => { onSyncEventRef.current = onSyncEvent; }, [onSyncEvent]);

  // ── Token fetch ──────────────────────────────────────────────────────────
  const fetchToken = useCallback(
    async (signal: AbortSignal): Promise<TokenResponse> => {
      const res = await fetch(`/api/room/${roomId}/token`, {
        method: "GET",
        credentials: "include",
        signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Token fetch failed: ${res.status}`);
      }

      return res.json() as Promise<TokenResponse>;
    },
    [roomId],
  );

  // ── Token refresh scheduler ──────────────────────────────────────────────
  const scheduleTokenRefresh = useCallback(
    (tokenData: TokenResponse, signal: AbortSignal) => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }

      const delayMs = Math.max(
        0,
        tokenData.refreshAt * 1000 - Date.now(),
      );

      refreshTimerRef.current = setTimeout(async () => {
        if (signal.aborted) return;

        log.info({ roomId }, "Refreshing LiveKit token before expiry");

        try {
          const freshToken = await fetchToken(signal);
          tokenRef.current = freshToken;

          if (roomRef.current !== null && !signal.aborted) {
            // LiveKit SDK's prepareConnection doesn't exist in all versions;
            // instead we gracefully reconnect with the fresh token.
            await roomRef.current.connect(
              freshToken.livekitUrl,
              freshToken.token,
            );
            scheduleTokenRefresh(freshToken, signal);
          }
        } catch (err) {
          if (!signal.aborted) {
            log.error({ err, roomId }, "Token refresh failed");
          }
        }
      }, delayMs);
    },
    [fetchToken, roomId],
  );

  // ── Participant count updater ────────────────────────────────────────────
  const updateParticipantCount = useCallback((room: Room) => {
    setRemoteParticipantCount(room.remoteParticipants.size);
  }, []);

  // ── DataChannel message handler ──────────────────────────────────────────
  const handleDataReceived = useCallback(
    (
      payload: Uint8Array,
      participant: RemoteParticipant | undefined,
    ) => {
      // Participant is undefined for data sent from server (not a peer)
      if (participant === undefined) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(TEXT_DECODER.decode(payload));
      } catch {
        log.warn({ participantIdentity: participant.identity }, "Received non-JSON DataChannel message");
        return;
      }

      if (!isSyncEnvelope(parsed)) {
        log.warn({ parsed }, "Received DataChannel message with invalid schema");
        return;
      }

      // Ignore events intended for a different room (multi-tab guard)
      if (parsed.roomId !== roomId) return;

      // Calculate one-way drift approximation
      const now = Date.now();
      const latency = Math.max(0, now - parsed.sentAt);
      setDriftMs(latency);

      // Dispatch to consumer callback
      onSyncEventRef.current?.(parsed, participant);
    },
    [roomId],
  );

  // ── Main connect sequence ─────────────────────────────────────────────────
  const connect = useCallback(
    async (signal: AbortSignal) => {
      while (retryRef.current <= maxRetries) {
        if (signal.aborted) return;

        const attempt = retryRef.current;

        if (attempt > 0) {
          const delay = backoffMs(attempt);
          log.info({ roomId, attempt, delay }, "Retrying connection");
          await sleep(delay);
          if (signal.aborted) return;
        }

        try {
          // ── Phase 1: Fetch token ─────────────────────────────────────────
          setConnectionState("fetching");
          const tokenData = await fetchToken(signal);
          if (signal.aborted) return;
          tokenRef.current = tokenData;

          // ── Phase 2: Build Room instance ─────────────────────────────────
          const room = new Room({
            adaptiveStream:     true,
            dynacast:           false,  // No media tracks — disable dynacast
            stopLocalTrackOnUnpublish: true,
            reconnectPolicy: {
              nextRetryDelayInMs: (context) => {
                const d = Math.min(
                  BACKOFF_BASE_MS * Math.pow(2, context.retryCount),
                  BACKOFF_CAP_MS,
                );
                return d;
              },
            },
          });

          roomRef.current = room;

          // ── Phase 3: Attach event listeners ──────────────────────────────
          room
            .on(RoomEvent.Connected, () => {
              retryRef.current = 0;
              setConnectionState("connected");
              updateParticipantCount(room);
              log.info({ roomId }, "LiveKit room connected");
            })
            .on(RoomEvent.Reconnecting, () => {
              setConnectionState("reconnecting");
              log.info({ roomId }, "LiveKit reconnecting…");
            })
            .on(RoomEvent.Reconnected, () => {
              setConnectionState("connected");
              log.info({ roomId }, "LiveKit reconnected");
            })
            .on(RoomEvent.Disconnected, (reason) => {
              setConnectionState("disconnected");
              log.info({ roomId, reason }, "LiveKit disconnected");
            })
            .on(RoomEvent.DataReceived, handleDataReceived)
            .on(RoomEvent.ParticipantConnected, () => {
              updateParticipantCount(room);
            })
            .on(RoomEvent.ParticipantDisconnected, () => {
              updateParticipantCount(room);
            });

          // ── Phase 4: Connect ──────────────────────────────────────────────
          setConnectionState("connecting");
          await room.connect(tokenData.livekitUrl, tokenData.token, {
            autoSubscribe: false, // Data only — we never auto-subscribe to tracks
          });

          if (signal.aborted) {
            await room.disconnect();
            return;
          }

          // ── Phase 5: Schedule token refresh ──────────────────────────────
          scheduleTokenRefresh(tokenData, signal);

          // Connection succeeded — exit retry loop
          return;
        } catch (err) {
          if (signal.aborted) return;

          log.error({ err, roomId, attempt }, "Room connection error");
          retryRef.current += 1;

          if (retryRef.current > maxRetries) {
            setConnectionState("failed");
            log.error({ roomId }, "Max retries exhausted — entering failed state");
            return;
          }
        }
      }
    },
    [
      fetchToken,
      handleDataReceived,
      maxRetries,
      roomId,
      scheduleTokenRefresh,
      updateParticipantCount,
    ],
  );

  // ── Effect: mount → connect, unmount → disconnect ────────────────────────
  useEffect(() => {
    const abort = new AbortController();
    abortRef.current = abort;
    retryRef.current = 0;

    void connect(abort.signal);

    return () => {
      abort.abort();

      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }

      // Graceful disconnect — fire-and-forget on unmount
      if (roomRef.current !== null) {
        void roomRef.current.disconnect().catch((err: unknown) => {
          log.warn({ err }, "Error during room disconnect on unmount");
        });
        roomRef.current = null;
      }
    };
  }, [connect]);

  // ── publishSyncEvent ─────────────────────────────────────────────────────
  const publishSyncEvent = useCallback(
    async (action: SyncAction, timestamp: number): Promise<void> => {
      const room = roomRef.current;

      if (
        room === null ||
        room.state !== ConnectionState.Connected
      ) {
        throw new Error(
          "Cannot publish sync event: room is not connected. " +
            `Current state: ${room?.state ?? "null"}`,
        );
      }

      const localParticipant = room.localParticipant;
      const identity = localParticipant.identity;

      const envelope: SyncEnvelope = {
        action,
        timestamp,
        sentAt: Date.now(),
        roomId,
        senderId: identity,
      };

      const encoded = TEXT_ENCODER.encode(JSON.stringify(envelope));

      // RELIABLE delivery for play/pause; LOSSY is acceptable for rapid seek
      // events (the adapter debounces before calling this, so each call is
      // semantically meaningful — use RELIABLE for all).
      await localParticipant.publishData(encoded, {
        reliable: true,
        // topic scoping — allows future filtering without schema changes
        topic: `whs.sync.${action}`,
      });

      log.debug(
        { action, timestamp, roomId },
        "Sync event published",
      );
    },
    [roomId],
  );

  // ── disconnect ───────────────────────────────────────────────────────────
  const disconnect = useCallback(async (): Promise<void> => {
    abortRef.current.abort();

    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }

    if (roomRef.current !== null) {
      await roomRef.current.disconnect();
      roomRef.current = null;
    }

    setConnectionState("disconnected");
  }, []);

  // ── Return ───────────────────────────────────────────────────────────────
  return {
    connectionState,
    publishSyncEvent,
    driftMs,
    remoteParticipantCount,
    disconnect,
    roomRef,
  };
}
