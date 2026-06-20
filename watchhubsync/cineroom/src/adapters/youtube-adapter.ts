/**
 * src/adapters/youtube-adapter.ts
 *
 * YouTubeAdapter — Concrete OTT Sync Adapter for YouTube.
 *
 * ─── ZERO-PROXY LEGAL MANDATE ────────────────────────────────────────────────
 * This adapter does NOT proxy, intercept, buffer, copy, or retransmit any
 * video or audio data.
 *
 * It observes the native HTML5 <video> element's DOM events:
 *   - 'play'    — user pressed play (or autoplay)
 *   - 'pause'   — user pressed pause
 *   - 'seeked'  — playhead moved to a new position (debounced)
 *
 * The `forceSync(timestamp)` method sets `video.currentTime` — a W3C
 * standard HTML5 API. The browser's native media pipeline, subject to full
 * EME / Widevine licensing, handles the actual segment fetch and decrypt.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * YouTube DOM notes:
 *
 *   YouTube renders its player as a custom element `<ytd-app>` with a single
 *   HTML5 <video> inside `.html5-main-video`. This selector has been stable
 *   since 2017 but YouTube does refactor periodically. The adapter supports
 *   a configurable fallback selector and a DOM poll timeout.
 *
 *   Key quirks:
 *
 *   1. YouTube fires 'seeked' many times during scrubbing (every frame).
 *      We debounce at 300ms (configurable) to emit a single event after the
 *      user lifts their finger, preventing WebSocket flooding.
 *
 *   2. YouTube fires 'play' immediately after a programmatic seek even if the
 *      user had paused before seeking. We track `_wasPausedBeforeSeek` to
 *      suppress these phantom play events.
 *
 *   3. YouTube's internal state machine occasionally emits spurious 'pause'
 *      events during buffering stalls. We guard with `_isBuffering` detection
 *      via the 'waiting' and 'canplay' events.
 *
 *   4. SPA navigation: YouTube is a single-page app. If the user navigates
 *      to a new video, the <video> element is replaced. We monitor for this
 *      with a MutationObserver on the player container and re-attach.
 *
 * Usage:
 *
 *   const adapter = new YouTubeAdapter({ seekDebounceMs: 300 });
 *
 *   adapter.on('play',  ({ currentTime }) => sync.publishSyncEvent('play', currentTime));
 *   adapter.on('pause', ({ currentTime }) => sync.publishSyncEvent('pause', currentTime));
 *   adapter.on('seek',  ({ currentTime }) => sync.publishSyncEvent('seek', currentTime));
 *   adapter.on('error', (err) => console.error(err));
 *
 *   await adapter.attach();
 *
 *   // When a remote sync event arrives:
 *   sync.onSyncEvent = ({ action, timestamp }) => {
 *     if (action === 'seek') adapter.forceSync(timestamp);
 *     if (action === 'play') { adapter.forceSync(timestamp); video.play(); }
 *     if (action === 'pause') { adapter.forceSync(timestamp); video.pause(); }
 *   };
 *
 *   // Cleanup:
 *   adapter.detach();
 */

import {
  BaseOTTAdapter,
  type AdapterConfig,
  type OTTPlatform,
} from "./base-adapter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Primary selector — targets the main video element inside YouTube's player.
 * Tested stable as of 2024. Adapter falls back to `video` if this fails.
 */
const YT_VIDEO_SELECTOR_PRIMARY = ".html5-main-video" as const;

/**
 * Container selector — watched by MutationObserver for SPA navigations
 * where the <video> element is replaced without a full page load.
 */
const YT_PLAYER_CONTAINER_SELECTOR = "#movie_player" as const;

/**
 * Threshold (seconds) for considering a seek "significant" enough to emit.
 * Tiny currentTime fluctuations (<0.2s) from YouTube's internal timeupdate
 * are suppressed to avoid false seek events.
 */
const SEEK_THRESHOLD_S = 0.2 as const;

/**
 * When we call forceSync(), we set currentTime to `timestamp + this offset`.
 * This small positive offset compensates for the network latency already
 * elapsed between the sender emitting the event and us receiving it.
 * The hook exposes `driftMs` — callers should pass it here.
 */
const DEFAULT_LATENCY_COMPENSATION_S = 0 as const;

// ---------------------------------------------------------------------------
// YouTubeAdapter
// ---------------------------------------------------------------------------

export interface YouTubeAdapterConfig extends AdapterConfig {
  /**
   * Additional latency compensation (seconds) applied when forceSync is called.
   * Set this to `driftMs / 1000` from `useRoomSync` for precise alignment.
   * Defaults to 0.
   */
  readonly latencyCompensationS?: number;
}

export class YouTubeAdapter extends BaseOTTAdapter {
  // ── Abstract implementations ─────────────────────────────────────────────
  readonly platform: OTTPlatform = "youtube";
  protected readonly defaultVideoSelector = YT_VIDEO_SELECTOR_PRIMARY;

  // ── Config ────────────────────────────────────────────────────────────────
  private readonly _latencyCompensationS: number;

  // ── DOM listener references (stored so we can removeEventListener) ────────
  private _onPlayBound:    (() => void) | null = null;
  private _onPauseBound:   (() => void) | null = null;
  private _onSeekedBound:  (() => void) | null = null;
  private _onWaitingBound: (() => void) | null = null;
  private _onCanPlayBound: (() => void) | null = null;

  // ── Debounce teardown handle ──────────────────────────────────────────────
  private _cancelSeekDebounce: (() => void) | null = null;

  // ── State tracking ────────────────────────────────────────────────────────
  /** True while the browser is buffering (stalled) — suppresses false pauses. */
  private _isBuffering = false;
  /** Playback position just before a seek began — used in SeekEvent. */
  private _timeBeforeSeek: number | undefined = undefined;
  /** True if the video was paused when a seek started. */
  private _wasPausedBeforeSeek = false;

  // ── SPA re-attach support ─────────────────────────────────────────────────
  private _containerObserver: MutationObserver | null = null;

  constructor(config: YouTubeAdapterConfig = {}) {
    super(config);
    this._latencyCompensationS =
      config.latencyCompensationS ?? DEFAULT_LATENCY_COMPENSATION_S;
  }

  // ---------------------------------------------------------------------------
  // attach()
  // ---------------------------------------------------------------------------

  async attach(): Promise<void> {
    if (this.isAttached) {
      this._config.logger.warn("attach() called while already attached — detaching first");
      this.detach();
    }

    const selector =
      this._config.videoSelector.length > 0
        ? this._config.videoSelector
        : this.defaultVideoSelector;

    this._config.logger.info("Attaching to YouTube player", { selector });

    // ── 1. Query video element (polls until found or timeout) ──────────────
    let videoEl: HTMLVideoElement;
    try {
      videoEl = await this._queryVideoElement(selector, this._config.attachTimeoutMs);
    } catch (cause) {
      // Fallback to bare `video` selector before giving up
      this._config.logger.warn(
        `Primary selector "${selector}" failed — trying generic 'video' fallback`,
      );
      try {
        videoEl = await this._queryVideoElement("video", 2_000);
      } catch (fallbackCause) {
        this._emitError(
          "VIDEO_ELEMENT_NOT_FOUND",
          `Could not locate a <video> element on this page. ` +
            `Is this a YouTube watch page?`,
          { primary: cause, fallback: fallbackCause },
        );
        return;
      }
    }

    // ── 2. Bind listeners ─────────────────────────────────────────────────
    try {
      this._bindListeners(videoEl);
    } catch (cause) {
      this._emitError("ATTACH_FAILED", "Failed to bind event listeners", cause);
      return;
    }

    this._videoElement = videoEl;

    // ── 3. Start SPA navigation observer ─────────────────────────────────
    this._watchForNavigation();

    // ── 4. Signal successful attach ───────────────────────────────────────
    this._onAttached();
  }

  // ---------------------------------------------------------------------------
  // detach()
  // ---------------------------------------------------------------------------

  detach(): void {
    if (this._videoElement !== null) {
      this._removeListeners(this._videoElement);
    }

    // Stop the SPA observer
    if (this._containerObserver !== null) {
      this._containerObserver.disconnect();
      this._containerObserver = null;
    }

    // Cancel any pending debounced seek
    this._cancelSeekDebounce?.();
    this._cancelSeekDebounce = null;

    this._videoElement    = null;
    this._isBuffering     = false;
    this._isForceSyncing  = false;
    this._timeBeforeSeek  = undefined;
    this._wasPausedBeforeSeek = false;

    this._onAttached;   // silence unused-var lint (these are already null)
    this._onPlayBound   = null;
    this._onPauseBound  = null;
    this._onSeekedBound = null;
    this._onWaitingBound = null;
    this._onCanPlayBound = null;

    this._onDetached();
  }

  // ---------------------------------------------------------------------------
  // forceSync(timestamp)
  // ---------------------------------------------------------------------------

  /**
   * Imperatively seek the local YouTube player to `timestamp` seconds.
   *
   * Sets the flag `_isForceSyncing = true` before seeking so that our own
   * 'seeked' listener ignores this programmatic seek, preventing a sync loop
   * where we re-emit the event back to the room.
   *
   * ZERO-PROXY NOTE: This calls `video.currentTime = ...` — a standard
   * browser API. The browser fetches the corresponding media segment from
   * YouTube's CDN and decrypts it through the Widevine CDM. We touch no
   * bytes of media data.
   */
  forceSync(timestamp: number): void {
    const video = this._videoElement;
    if (video === null) {
      this._emitError(
        "FORCE_SYNC_FAILED",
        "forceSync() called but adapter is not attached",
      );
      return;
    }

    if (!Number.isFinite(timestamp) || timestamp < 0) {
      this._emitError(
        "FORCE_SYNC_FAILED",
        `forceSync() received invalid timestamp: ${timestamp}`,
      );
      return;
    }

    // Cancel any pending debounced seek — our programmatic seek would otherwise
    // trigger it after the debounce window.
    this._cancelSeekDebounce?.();

    this._isForceSyncing = true;
    try {
      const target = timestamp + this._latencyCompensationS;
      const clamped = Math.max(0, Math.min(target, video.duration || Infinity));

      this._config.logger.debug("forceSync", {
        target,
        clamped,
        currentTime: video.currentTime,
        delta: Math.abs(clamped - video.currentTime),
      });

      video.currentTime = clamped;
    } finally {
      // Reset the flag on the next microtask tick so that the 'seeked' event
      // that fires synchronously during currentTime assignment is still
      // suppressed, while future user-initiated seeks are captured correctly.
      queueMicrotask(() => {
        this._isForceSyncing = false;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: bind / remove listeners
  // ---------------------------------------------------------------------------

  private _bindListeners(video: HTMLVideoElement): void {
    // ── play ────────────────────────────────────────────────────────────────
    this._onPlayBound = (): void => {
      // Suppress phantom 'play' events fired by YouTube after a programmatic
      // seek, even if the video was paused before. We detect this by checking
      // if a forceSync is in progress OR if a seek happened just prior and the
      // user was paused.
      if (this._isForceSyncing) return;
      if (this._wasPausedBeforeSeek) {
        // YouTube fires play → seeked → pause in sequence during internal seeks.
        // The first 'play' in this sequence should be suppressed.
        this._wasPausedBeforeSeek = false;
        return;
      }

      const ct = video.currentTime;
      this._config.logger.debug("play event", { currentTime: ct });
      this._emitPlay(ct);
    };

    // ── pause ───────────────────────────────────────────────────────────────
    this._onPauseBound = (): void => {
      // Suppress pauses caused by buffering stalls.
      if (this._isBuffering) return;
      // Suppress pauses caused by our own forceSync seek.
      if (this._isForceSyncing) return;

      const ct = video.currentTime;
      this._config.logger.debug("pause event", { currentTime: ct });
      this._emitPause(ct);
    };

    // ── seeked (debounced) ──────────────────────────────────────────────────
    //
    // 'seeking' fires continuously during scrubbing.
    // 'seeked' fires once per completed seek, but YouTube can fire it many
    // times in quick succession during rapid scrubbing. We debounce.
    //
    // We also capture the time BEFORE the seek started using the 'seeking'
    // event (not the 'seeked' event) so we can include it in SeekEvent.
    // However, 'seeking' is too noisy to debounce effectively. Instead, we
    // snapshot currentTime at the moment we enter the debounce window.

    // Track time before seek using 'seeking' event (fires immediately)
    const onSeeking = (): void => {
      if (this._isForceSyncing) return;
      if (this._timeBeforeSeek === undefined) {
        this._timeBeforeSeek = video.currentTime;
      }
      this._wasPausedBeforeSeek = video.paused;
    };
    video.addEventListener("seeking", onSeeking, { passive: true });

    // Store seeking listener for cleanup (captured in closure below)
    const removeSeeking = (): void => {
      video.removeEventListener("seeking", onSeeking);
    };

    const [debouncedSeek, cancelSeek] = this._debounce((): void => {
      if (this._isForceSyncing) {
        this._timeBeforeSeek = undefined;
        return;
      }

      const currentTime = video.currentTime;
      const previousTime = this._timeBeforeSeek;
      this._timeBeforeSeek = undefined;

      // Filter out negligible position fluctuations from YouTube's
      // internal timeupdate / segment transitions.
      const delta = previousTime !== undefined
        ? Math.abs(currentTime - previousTime)
        : Infinity;

      if (delta < SEEK_THRESHOLD_S) {
        this._config.logger.debug("seeked suppressed (below threshold)", {
          currentTime,
          previousTime,
          delta,
        });
        return;
      }

      this._config.logger.debug("seeked event", { currentTime, previousTime });
      this._emitSeek(currentTime, previousTime);
    }, this._config.seekDebounceMs);

    this._onSeekedBound = (): void => {
      if (this._isForceSyncing) return;
      debouncedSeek();
    };

    // Compose the cancel function to also remove the 'seeking' listener
    this._cancelSeekDebounce = (): void => {
      cancelSeek();
      removeSeeking();
    };

    // ── buffering detection ─────────────────────────────────────────────────
    this._onWaitingBound = (): void => { this._isBuffering = true; };
    this._onCanPlayBound = (): void => { this._isBuffering = false; };

    // ── Register all ──────────────────────────────────────────────────────
    video.addEventListener("play",    this._onPlayBound!,    { passive: true });
    video.addEventListener("pause",   this._onPauseBound!,   { passive: true });
    video.addEventListener("seeked",  this._onSeekedBound!,  { passive: true });
    video.addEventListener("waiting", this._onWaitingBound!, { passive: true });
    video.addEventListener("canplay", this._onCanPlayBound!, { passive: true });
  }

  private _removeListeners(video: HTMLVideoElement): void {
    if (this._onPlayBound    !== null) video.removeEventListener("play",    this._onPlayBound);
    if (this._onPauseBound   !== null) video.removeEventListener("pause",   this._onPauseBound);
    if (this._onSeekedBound  !== null) video.removeEventListener("seeked",  this._onSeekedBound);
    if (this._onWaitingBound !== null) video.removeEventListener("waiting", this._onWaitingBound);
    if (this._onCanPlayBound !== null) video.removeEventListener("canplay", this._onCanPlayBound);

    this._cancelSeekDebounce?.();
  }

  // ---------------------------------------------------------------------------
  // Private: SPA navigation watcher
  // ---------------------------------------------------------------------------

  /**
   * YouTube is a single-page app (Polymer / LitElement).
   * When the user navigates to a different video, the `#movie_player` DOM
   * subtree is torn down and rebuilt — replacing the <video> element.
   *
   * We watch the player container with a MutationObserver. If the video
   * element is replaced (detected by `src` change or element identity), we
   * transparently re-attach.
   */
  private _watchForNavigation(): void {
    const container = document.querySelector(YT_PLAYER_CONTAINER_SELECTOR);
    if (container === null) {
      this._config.logger.warn(
        "Could not find YouTube player container for SPA navigation watch. " +
          "Navigation to new videos may break sync.",
      );
      return;
    }

    let lastVideoEl = this._videoElement;

    this._containerObserver = new MutationObserver(() => {
      const currentVideo =
        container.querySelector<HTMLVideoElement>(
          this._config.videoSelector.length > 0
            ? this._config.videoSelector
            : this.defaultVideoSelector,
        ) ??
        container.querySelector<HTMLVideoElement>("video");

      if (currentVideo === null) return;
      if (currentVideo === lastVideoEl) return;

      // Video element was replaced — re-attach
      this._config.logger.info(
        "YouTube video element replaced (SPA navigation) — re-attaching",
      );

      if (lastVideoEl !== null) {
        this._removeListeners(lastVideoEl);
      }

      try {
        this._bindListeners(currentVideo);
        this._videoElement = currentVideo;
        lastVideoEl = currentVideo;
        this._config.logger.info("Re-attached to new video element after SPA navigation");
      } catch (cause) {
        this._emitError(
          "ATTACH_FAILED",
          "Failed to re-attach after SPA navigation",
          cause,
        );
      }
    });

    this._containerObserver.observe(container, {
      childList: true,
      subtree:   true,
      // We do not observe attributes or character data — only structural changes
    });
  }
}
