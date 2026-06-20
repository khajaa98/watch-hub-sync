/**
 * src/adapters/base-adapter.ts
 *
 * BaseOTTAdapter — Abstract Contract for All OTT Sync Adapters.
 *
 * ─── ZERO-PROXY LEGAL MANDATE ────────────────────────────────────────────────
 * These adapters are PURELY STATE-SYNCHRONIZATION OBSERVERS.
 *
 * They MUST:
 *   ✓ Observe native HTML5 <video> element events (play, pause, seeked)
 *   ✓ Read the current playback position (video.currentTime)
 *   ✓ Emit strongly-typed events to the sync engine
 *   ✓ Accept forceSync(timestamp) to adjust the local player's currentTime
 *
 * They MUST NOT:
 *   ✗ Intercept, buffer, copy, re-transmit, or proxy any video/audio bytes
 *   ✗ Override or monkey-patch the browser's EME / Encrypted Media Extensions
 *   ✗ Bypass, circumvent, or interfere with DRM (Widevine, PlayReady, FairPlay)
 *   ✗ Make any network requests to the OTT platform's servers
 *   ✗ Inject scripts that alter the platform's authentication or licensing
 *   ✗ Capture any frames or media data
 *
 * All `forceSync(timestamp)` implementations set `video.currentTime` — a
 * standard browser API that instructs the browser's native media pipeline to
 * seek. The browser still fetches, decrypts, and renders the content through
 * its own DRM-compliant path. No bytes are captured or re-routed.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Adapter lifecycle:
 *
 *   new ConcreteAdapter(config)
 *       │
 *       ▼
 *   adapter.attach()           — query DOM, bind event listeners
 *       │
 *       ├── events emit → onPlay / onPause / onSeek
 *       │
 *   adapter.forceSync(ts)      — (optional) impose remote timestamp
 *       │
 *       ▼
 *   adapter.detach()           — remove all listeners, release references
 *
 * Event subscription:
 *
 *   adapter.on('play',  handler)
 *   adapter.on('pause', handler)
 *   adapter.on('seek',  handler)
 *   adapter.on('error', handler)
 *   adapter.off('play', handler)
 *
 * Implementors must override all abstract methods.
 * Lifecycle hooks (onAttach, onDetach) are optional extension points.
 */

// ---------------------------------------------------------------------------
// Shared types (re-exported for consumers)
// ---------------------------------------------------------------------------

/**
 * Supported OTT platforms. Adding a new platform means implementing a new
 * concrete adapter — no changes to the base class are required.
 */
export type OTTPlatform =
  | "youtube"
  | "jiohotstar"
  | "netflix"
  | "primevideo";

/**
 * A playback event emitted by an adapter to the sync engine.
 * Mirrors SyncEnvelope but is adapter-local before being forwarded to LiveKit.
 */
export interface AdapterPlaybackEvent {
  /** Type of playback state change. */
  readonly type: "play" | "pause" | "seek";
  /**
   * Current playback position in fractional seconds at the moment of emission.
   * Precision varies by platform (HTML5 video is typically ≤1ms).
   */
  readonly currentTime: number;
  /**
   * Monotonic performance timestamp (ms) from `performance.now()` at emission.
   * Used for sub-second drift compensation independent of wall clock skew.
   */
  readonly performanceNow: number;
  /** The OTT platform this event originated from. */
  readonly platform: OTTPlatform;
}

/** A seek event carries both the time before and after the seek. */
export interface AdapterSeekEvent extends AdapterPlaybackEvent {
  readonly type: "seek";
  /** Playback position before the seek (seconds). May be undefined if unknown. */
  readonly previousTime: number | undefined;
}

/** Union of all adapter event payloads. */
export type AdapterEvent =
  | AdapterPlaybackEvent
  | AdapterSeekEvent;

/** Event names exposed by the adapter's event emitter interface. */
export type AdapterEventName = "play" | "pause" | "seek" | "error" | "attached" | "detached";

/** Handler signatures by event name. */
export interface AdapterEventHandlers {
  play:     (event: AdapterPlaybackEvent) => void;
  pause:    (event: AdapterPlaybackEvent) => void;
  seek:     (event: AdapterSeekEvent)     => void;
  error:    (err: AdapterError)           => void;
  attached: ()                            => void;
  detached: ()                            => void;
}

/** Structured error type for adapter failures. */
export interface AdapterError {
  readonly code:
    | "VIDEO_ELEMENT_NOT_FOUND"
    | "ATTACH_FAILED"
    | "FORCE_SYNC_FAILED"
    | "UNKNOWN";
  readonly message: string;
  readonly cause?: unknown;
  readonly platform: OTTPlatform;
}

/** Configuration passed to every adapter constructor. */
export interface AdapterConfig {
  /**
   * CSS selector to query the <video> element. Adapters have default selectors
   * for their platform but allow override for resilience against DOM changes.
   */
  readonly videoSelector?: string;
  /**
   * Maximum time (ms) to wait for the video element to appear in the DOM
   * after `attach()` is called. Defaults to 10,000ms.
   */
  readonly attachTimeoutMs?: number;
  /**
   * Debounce window (ms) applied to 'seeked' events to prevent WebSocket
   * flooding during rapid scrubbing. Defaults to 300ms.
   */
  readonly seekDebounceMs?: number;
  /**
   * Optional logger override. If omitted, the adapter uses console methods
   * with a structured prefix. Adapters run in content-script context where
   * the app logger may not be available.
   */
  readonly logger?: AdapterLogger;
}

export interface AdapterLogger {
  info:  (msg: string, data?: object) => void;
  warn:  (msg: string, data?: object) => void;
  error: (msg: string, data?: object) => void;
  debug: (msg: string, data?: object) => void;
}

// ---------------------------------------------------------------------------
// Default adapter configuration
// ---------------------------------------------------------------------------

export const ADAPTER_DEFAULTS = {
  attachTimeoutMs: 10_000,
  seekDebounceMs:  300,
} as const;

// ---------------------------------------------------------------------------
// Minimal event emitter (framework-free, runs in content-script context)
// ---------------------------------------------------------------------------

type ListenerMap = {
  [K in AdapterEventName]: Set<AdapterEventHandlers[K]>;
};

class AdapterEventEmitter {
  private readonly _listeners: ListenerMap = {
    play:     new Set(),
    pause:    new Set(),
    seek:     new Set(),
    error:    new Set(),
    attached: new Set(),
    detached: new Set(),
  };

  on<K extends AdapterEventName>(
    event: K,
    handler: AdapterEventHandlers[K],
  ): this {
    // Type assertion needed because TypeScript can't narrow Set<T> from the
    // union map pattern without casting.
    (this._listeners[event] as Set<AdapterEventHandlers[K]>).add(handler);
    return this;
  }

  off<K extends AdapterEventName>(
    event: K,
    handler: AdapterEventHandlers[K],
  ): this {
    (this._listeners[event] as Set<AdapterEventHandlers[K]>).delete(handler);
    return this;
  }

  once<K extends AdapterEventName>(
    event: K,
    handler: AdapterEventHandlers[K],
  ): this {
    const wrapper = (...args: Parameters<AdapterEventHandlers[K]>) => {
      // @ts-expect-error — spread args through the handler union
      handler(...args);
      this.off(event, wrapper as AdapterEventHandlers[K]);
    };
    this.on(event, wrapper as AdapterEventHandlers[K]);
    return this;
  }

  protected emit<K extends AdapterEventName>(
    event: K,
    ...args: Parameters<AdapterEventHandlers[K]>
  ): void {
    for (const listener of this._listeners[event]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        // Never let a consumer callback crash the adapter
        this._safeConsoleError("Listener threw during event dispatch", { event, err });
      }
    }
  }

  removeAllListeners(event?: AdapterEventName): void {
    if (event !== undefined) {
      this._listeners[event].clear();
    } else {
      for (const key of Object.keys(this._listeners) as AdapterEventName[]) {
        this._listeners[key].clear();
      }
    }
  }

  private _safeConsoleError(msg: string, data: object): void {
    try {
      console.error(`[WHS/Adapter] ${msg}`, data);
    } catch {
      // Absolute last resort — content-script console may be unavailable
    }
  }
}

// ---------------------------------------------------------------------------
// Abstract base adapter
// ---------------------------------------------------------------------------

/**
 * BaseOTTAdapter
 *
 * Extend this class to add support for a new streaming platform.
 * Implementors must provide:
 *   - `platform`           — readonly platform identifier
 *   - `defaultVideoSelector` — fallback CSS selector for the <video> element
 *   - `attach()`           — bind DOM listeners, set `_videoElement`, call `super._onAttached()`
 *   - `detach()`           — remove all DOM listeners, null `_videoElement`, call `super._onDetached()`
 *   - `forceSync(ts)`      — seek the local player to `ts` without emitting sync events
 *
 * The base class provides:
 *   - Event emitter (`on`, `off`, `once`, `emit`)
 *   - Protected helpers: `_emitPlay`, `_emitPause`, `_emitSeek`, `_emitError`
 *   - `_queryVideoElement(selector, timeoutMs)` — polls for the element
 *   - `_debounce(fn, ms)` — for seek event throttling
 *   - State tracking: `isAttached`, `isForceSyncing`
 */
export abstract class BaseOTTAdapter extends AdapterEventEmitter {
  /** Platform identifier — must be a constant in subclasses. */
  abstract readonly platform: OTTPlatform;

  /** Default CSS selector for the platform's <video> element. */
  protected abstract readonly defaultVideoSelector: string;

  /** Reference to the observed <video> element. Null when not attached. */
  protected _videoElement: HTMLVideoElement | null = null;

  /** True while the adapter is observing a live video element. */
  get isAttached(): boolean {
    return this._videoElement !== null;
  }

  /**
   * True during a `forceSync()` call. Implementations MUST set this to true
   * at the start of forceSync and false at the end. This flag allows event
   * listeners to suppress re-emission of seek events caused by our own
   * programmatic seek (not a user action) — preventing sync loops.
   */
  protected _isForceSyncing = false;

  get isForceSyncing(): boolean {
    return this._isForceSyncing;
  }

  protected readonly _config: Required<
    Pick<AdapterConfig, "attachTimeoutMs" | "seekDebounceMs">
  > & {
    videoSelector: string;
    logger: AdapterLogger;
  };

  constructor(config: AdapterConfig = {}) {
    super();

    const defaultLogger: AdapterLogger = {
      info:  (msg, data) => console.info(`[WHS/${this.platform}] ${msg}`, data ?? ""),
      warn:  (msg, data) => console.warn(`[WHS/${this.platform}] ${msg}`, data ?? ""),
      error: (msg, data) => console.error(`[WHS/${this.platform}] ${msg}`, data ?? ""),
      debug: (msg, data) => console.debug(`[WHS/${this.platform}] ${msg}`, data ?? ""),
    };

    // Config is finalized here but `defaultVideoSelector` is abstract and not
    // yet set — we defer selector resolution to first use in attach().
    this._config = {
      attachTimeoutMs: config.attachTimeoutMs ?? ADAPTER_DEFAULTS.attachTimeoutMs,
      seekDebounceMs:  config.seekDebounceMs  ?? ADAPTER_DEFAULTS.seekDebounceMs,
      videoSelector:   config.videoSelector   ?? "",  // resolved in attach()
      logger:          config.logger          ?? defaultLogger,
    };
  }

  // ── Abstract contract ────────────────────────────────────────────────────

  /**
   * Query the DOM, bind event listeners, and begin observing.
   *
   * Implementations MUST:
   *   1. Resolve the video element (using `_queryVideoElement` or platform-
   *      specific APIs)
   *   2. Bind all necessary event listeners
   *   3. Set `this._videoElement`
   *   4. Call `this._onAttached()` on success
   *
   * Implementations MUST NOT throw — errors should be emitted via
   * `this._emitError()` and the Promise should reject.
   */
  abstract attach(): Promise<void>;

  /**
   * Remove all event listeners and release the video element reference.
   *
   * Implementations MUST:
   *   1. Remove every listener added in `attach()`
   *   2. Set `this._videoElement = null`
   *   3. Call `this._onDetached()`
   *
   * Must be idempotent — safe to call multiple times.
   */
  abstract detach(): void;

  /**
   * Impose a remote playback position on the local player.
   *
   * This is the ONLY mechanism by which the remote state affects local
   * playback. It sets `video.currentTime` — a standard browser API.
   *
   * Implementations MUST:
   *   1. Set `this._isForceSyncing = true`
   *   2. Set `video.currentTime = timestamp`
   *   3. Set `this._isForceSyncing = false` (in a finally block)
   *
   * Implementations MUST NOT:
   *   - Emit seek events triggered by this call
   *   - Touch any DRM, EME, or network layer
   *
   * @param timestamp — Target playback position in fractional seconds
   */
  abstract forceSync(timestamp: number): void;

  // ── Optional lifecycle hooks ─────────────────────────────────────────────

  /**
   * Called after a successful attach. Override to run platform-specific
   * post-attach setup. Always call `super._onAttached()`.
   */
  protected _onAttached(): void {
    this._config.logger.info("Adapter attached", {
      selector: this._config.videoSelector || this.defaultVideoSelector,
    });
    this.emit("attached");
  }

  /**
   * Called after detach completes. Override for platform-specific teardown.
   * Always call `super._onDetached()`.
   */
  protected _onDetached(): void {
    this._config.logger.info("Adapter detached");
    this.emit("detached");
  }

  // ── Protected helpers for subclasses ─────────────────────────────────────

  /**
   * Poll the DOM for a <video> element matching `selector`, resolving once
   * found or rejecting after `timeoutMs`.
   *
   * Uses `MutationObserver` + `requestAnimationFrame` for efficient detection
   * without busy-polling.
   */
  protected _queryVideoElement(
    selector: string,
    timeoutMs: number,
  ): Promise<HTMLVideoElement> {
    return new Promise<HTMLVideoElement>((resolve, reject) => {
      // Immediate check — element may already be in DOM
      const immediate = document.querySelector<HTMLVideoElement>(selector);
      if (immediate !== null) {
        resolve(immediate);
        return;
      }

      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        reject(
          new Error(
            `Video element not found within ${timeoutMs}ms using selector "${selector}"`,
          ),
        );
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        if (settled) return;
        const el = document.querySelector<HTMLVideoElement>(selector);
        if (el !== null) {
          settled = true;
          clearTimeout(timeoutId);
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree:   true,
      });
    });
  }

  /**
   * Create a debounced version of a function.
   * Returns a tuple of [debouncedFn, cancel].
   */
  protected _debounce<T extends (...args: readonly unknown[]) => void>(
    fn: T,
    waitMs: number,
  ): [(...args: Parameters<T>) => void, () => void] {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const debounced = (...args: Parameters<T>): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, waitMs);
    };

    const cancel = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    return [debounced, cancel];
  }

  // ── Protected emit helpers ────────────────────────────────────────────────

  protected _emitPlay(currentTime: number): void {
    this.emit("play", {
      type:           "play",
      currentTime,
      performanceNow: performance.now(),
      platform:       this.platform,
    });
  }

  protected _emitPause(currentTime: number): void {
    this.emit("pause", {
      type:           "pause",
      currentTime,
      performanceNow: performance.now(),
      platform:       this.platform,
    });
  }

  protected _emitSeek(
    currentTime: number,
    previousTime: number | undefined,
  ): void {
    this.emit("seek", {
      type:           "seek",
      currentTime,
      previousTime,
      performanceNow: performance.now(),
      platform:       this.platform,
    });
  }

  protected _emitError(
    code: AdapterError["code"],
    message: string,
    cause?: unknown,
  ): void {
    const error: AdapterError = { code, message, cause, platform: this.platform };
    this._config.logger.error(message, { code, cause });
    this.emit("error", error);
  }
}
