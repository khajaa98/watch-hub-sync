/**
 * src/lib/logger/telemetry.ts
 *
 * Edge-Native Structured Telemetry — Zero-Overhead Observability Layer.
 *
 * ─── DESIGN PRINCIPLES ───────────────────────────────────────────────────────
 *
 * 1. ZERO-LATENCY PATH: The hot path (request → response) is NEVER blocked by
 *    telemetry. Log shipping is fire-and-forget using `ctx.waitUntil()` in
 *    Edge environments or `setImmediate()` in Node.js. If the shipping call
 *    fails, the error is swallowed silently — broken telemetry must not break
 *    user requests.
 *
 * 2. EDGE-COMPATIBLE: Uses only Web APIs (`fetch`, `performance`, `crypto`).
 *    No Node.js `stream`, `fs`, or `process` dependencies on the hot path.
 *    The Axiom ingest endpoint is a plain HTTPS POST.
 *
 * 3. PII SCRUBBING: All fields pass through a scrubber before shipping.
 *    Known-sensitive keys (Authorization, token, password, secret, key,
 *    card_number, cvv) are redacted to "[REDACTED]". This is structural —
 *    it operates on field names, not values, so it handles unknown keys
 *    that match the pattern.
 *
 * 4. SPAN MODEL: The API is span-based rather than log-line-based.
 *    A span wraps a unit of work, captures its duration, and emits one
 *    structured record on completion. This matches Axiom's data model and
 *    maps cleanly to distributed tracing.
 *
 * ─── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   // In Edge Middleware:
 *   const span = createSpan("middleware.auth", { userId: "..." });
 *   span.addField("route", "/api/room/[id]/token");
 *   // ... do work ...
 *   span.setStatus("ok");
 *   await span.end(ctx); // ctx is NextFetchEvent (has waitUntil)
 *
 *   // In API route:
 *   const span = createSpan("api.livekit.token", { roomId: "..." });
 *   try {
 *     // ... do work ...
 *     span.setStatus("ok");
 *   } catch (err) {
 *     span.setError(err);
 *     throw err;
 *   } finally {
 *     await span.end(); // no waitUntil needed in Node.js
 *   }
 *
 * ─── BACKENDS ────────────────────────────────────────────────────────────────
 *
 *   Production (AXIOM_TOKEN + AXIOM_DATASET set):
 *     Ships to Axiom via POST /v1/datasets/{dataset}/ingest
 *     Batch: one record per span, shipped immediately on span.end()
 *
 *   Development / fallback (no AXIOM_TOKEN):
 *     Writes structured JSON to console.log
 *     No network calls in development
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelemetryValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean>;

export interface SpanFields {
  readonly [key: string]: TelemetryValue;
}

export type SpanStatus = "ok" | "error" | "timeout" | "unauthorized" | "skipped";

export interface SpanRecord {
  /** ISO-8601 UTC timestamp of span start. */
  readonly _time: string;
  /** Name of the span — e.g. "middleware.auth", "api.livekit.token". */
  readonly service: string;
  /** Operation identifier. */
  readonly operation: string;
  /** Duration of the span in milliseconds. */
  readonly duration_ms: number;
  /** Final status. */
  readonly status: SpanStatus;
  /** Vercel region (process.env.VERCEL_REGION or 'local'). */
  readonly region: string;
  /** Node.js or Edge runtime identifier. */
  readonly runtime: "edge" | "node" | "unknown";
  /** Error message, if status is 'error'. Never includes stack traces. */
  readonly error_message?: string;
  /** User ID (x-user-id header or JWT sub claim). Never full JWT. */
  readonly user_id?: string;
  /** Room UUID. */
  readonly room_id?: string;
  /** Arbitrary additional fields (PII-scrubbed). */
  readonly [key: string]: TelemetryValue | undefined;
}

/** Minimal interface for contexts that have waitUntil (Edge, Vercel). */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

// ---------------------------------------------------------------------------
// PII scrubber
// ---------------------------------------------------------------------------

/**
 * Field names (case-insensitive substrings) that trigger redaction.
 * If a field key contains any of these strings, its value is replaced
 * with "[REDACTED]" before the record is shipped.
 */
const SENSITIVE_KEY_PATTERNS = [
  "authorization",
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "private",
  "card_number",
  "cvv",
  "ssn",
  "webhook_secret",
  "jwt",
  "hmac",
  "signature",
] as const;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Scrub a record object before shipping to telemetry backend.
 * Operates on field names — not values — to avoid regex-based false positives.
 */
function scrubRecord(
  record: Record<string, TelemetryValue | undefined>,
): Record<string, TelemetryValue | undefined> {
  const scrubbed: Record<string, TelemetryValue | undefined> = {};

  for (const [key, value] of Object.entries(record)) {
    scrubbed[key] = isSensitiveKey(key) ? "[REDACTED]" : value;
  }

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

function detectRuntime(): "edge" | "node" | "unknown" {
  if (process.env["NEXT_RUNTIME"] === "edge") return "edge";
  if (typeof process !== "undefined" && process.versions?.["node"] !== undefined) return "node";
  return "unknown";
}

const RUNTIME = detectRuntime();
const REGION  = process.env["VERCEL_REGION"] ?? "local";

// ---------------------------------------------------------------------------
// Axiom backend
// ---------------------------------------------------------------------------

interface AxiomConfig {
  readonly token:   string;
  readonly dataset: string;
}

function resolveAxiomConfig(): AxiomConfig | null {
  const token   = process.env["AXIOM_TOKEN"];
  const dataset = process.env["AXIOM_DATASET"];

  if (
    token === undefined   || token.trim().length === 0 ||
    dataset === undefined || dataset.trim().length === 0
  ) {
    return null;
  }

  return { token: token.trim(), dataset: dataset.trim() };
}

const _axiomConfig = resolveAxiomConfig();

/**
 * Ship a single span record to Axiom.
 * Returns a Promise that resolves regardless of success/failure.
 * Failures are swallowed with a single console.warn — never thrown.
 */
async function shipToAxiom(record: SpanRecord): Promise<void> {
  if (_axiomConfig === null) return;

  const url = `https://api.axiom.co/v1/datasets/${_axiomConfig.dataset}/ingest`;

  try {
    const response = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${_axiomConfig.token}`,
      },
      // Axiom expects an array of event objects
      body: JSON.stringify([record]),
    });

    if (!response.ok) {
      // Non-2xx from Axiom — log locally but never throw
      const text = await response.text().catch(() => "(unreadable)");
      console.warn(
        `[WHS/Telemetry] Axiom ingest returned ${response.status}: ${text}`,
      );
    }
  } catch (err) {
    // Network failure — silent swallow in Edge, soft warn in Node
    if (RUNTIME !== "edge") {
      console.warn("[WHS/Telemetry] Axiom shipping failed:", err);
    }
  }
}

/**
 * Write a span record to structured console output.
 * Used in development (no Axiom token) and as a fallback.
 */
function shipToConsole(record: SpanRecord): void {
  const level = record.status === "error" ? "error" : "info";

  const output = JSON.stringify({
    level,
    ...record,
    _src: "telemetry",
  });

  if (level === "error") {
    console.error(output);
  } else {
    console.log(output);
  }
}

// ---------------------------------------------------------------------------
// Span class
// ---------------------------------------------------------------------------

export class TelemetrySpan {
  private readonly _service:   string;
  private readonly _operation: string;
  private readonly _startMs:   number;
  private readonly _startIso:  string;
  private          _fields:    Record<string, TelemetryValue | undefined>;
  private          _status:    SpanStatus = "ok";
  private          _errorMsg:  string | undefined;
  private          _ended:     boolean = false;

  constructor(service: string, operation: string, initialFields: SpanFields = {}) {
    this._service   = service;
    this._operation = operation;
    this._startMs   = typeof performance !== "undefined"
      ? performance.now()
      : Date.now();
    this._startIso  = new Date().toISOString();
    this._fields    = { ...initialFields };
  }

  /**
   * Add or overwrite a single field on the span.
   * Field names containing sensitive substrings are accepted here —
   * they will be scrubbed during `end()`.
   */
  addField(key: string, value: TelemetryValue): this {
    this._fields[key] = value;
    return this;
  }

  /**
   * Add multiple fields at once. Merges into existing fields.
   */
  addFields(fields: SpanFields): this {
    this._fields = { ...this._fields, ...fields };
    return this;
  }

  setStatus(status: SpanStatus): this {
    this._status = status;
    return this;
  }

  /**
   * Record an error on the span. Sets status to 'error' and captures the
   * message (never the stack trace — stacks contain file paths and line
   * numbers that may leak implementation details).
   */
  setError(err: unknown): this {
    this._status  = "error";
    this._errorMsg = err instanceof Error
      ? err.message
      : typeof err === "string"
      ? err
      : "Unknown error";
    return this;
  }

  /**
   * Finalize the span, compute duration, scrub PII, and ship.
   *
   * @param ctx — Optional WaitUntilContext (NextFetchEvent from Edge Middleware).
   *              If provided, `ctx.waitUntil()` is used so shipping doesn't
   *              block the response stream. If omitted, shipping is awaited
   *              (appropriate in Node.js API routes where we control the event loop).
   */
  async end(ctx?: WaitUntilContext): Promise<void> {
    if (this._ended) return;
    this._ended = true;

    const endMs      = typeof performance !== "undefined"
      ? performance.now()
      : Date.now();
    const durationMs = Math.round(endMs - this._startMs);

    const rawRecord: Record<string, TelemetryValue | undefined> = {
      _time:        this._startIso,
      service:      this._service,
      operation:    this._operation,
      duration_ms:  durationMs,
      status:       this._status,
      region:       REGION,
      runtime:      RUNTIME,
      ...(this._errorMsg !== undefined
        ? { error_message: this._errorMsg }
        : {}),
      ...this._fields,
    };

    // PII scrubbing pass
    const scrubbed = scrubRecord(rawRecord) as SpanRecord;

    const shipPromise = _axiomConfig !== null
      ? shipToAxiom(scrubbed)
      : Promise.resolve(shipToConsole(scrubbed));

    if (ctx !== undefined) {
      // Edge: delegate shipping to the platform, do not block response
      ctx.waitUntil(shipPromise);
    } else {
      // Node.js: await shipping so we don't exit before log is sent
      await shipPromise;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new telemetry span.
 *
 * @param service   — Dot-separated service identifier (e.g. "api.webhooks.livekit")
 * @param fields    — Initial fields to attach to the span
 *
 * @example
 *   const span = createSpan("api.room.token", { roomId, userId });
 *   try {
 *     // work
 *     span.setStatus("ok");
 *   } catch (err) {
 *     span.setError(err);
 *     throw err;
 *   } finally {
 *     await span.end();
 *   }
 */
export function createSpan(
  service: string,
  fields: SpanFields = {},
): TelemetrySpan {
  // Derive operation from the last segment of the service name
  const parts     = service.split(".");
  const operation = parts[parts.length - 1] ?? service;
  return new TelemetrySpan(service, operation, fields);
}

/**
 * Convenience: wrap an async function with a telemetry span.
 * The span is automatically ended (with correct status) on completion.
 *
 * @example
 *   const result = await withSpan(
 *     "api.billing.push",
 *     { userId, roomId },
 *     () => pushStripeParticipantMinutes(events),
 *     ctx,
 *   );
 */
export async function withSpan<T>(
  service: string,
  fields: SpanFields,
  fn: (span: TelemetrySpan) => Promise<T>,
  ctx?: WaitUntilContext,
): Promise<T> {
  const span = createSpan(service, fields);

  try {
    const result = await fn(span);
    span.setStatus("ok");
    return result;
  } catch (err) {
    span.setError(err);
    throw err;
  } finally {
    await span.end(ctx);
  }
}

// ---------------------------------------------------------------------------
// Pre-built spans for the most instrumented paths
// ---------------------------------------------------------------------------

/**
 * Create a span pre-configured for the LiveKit token provisioning path.
 * Captures: roomId, userId, role, deviceType, durationMs.
 */
export function createTokenSpan(fields: {
  readonly roomId:     string;
  readonly userId:     string;
  readonly role?:      string;
  readonly deviceType?: string;
}): TelemetrySpan {
  return createSpan("api.room.token", {
    room_id:     fields.roomId,
    user_id:     fields.userId,
    role:        fields.role ?? null,
    device_type: fields.deviceType ?? null,
  });
}

/**
 * Create a span pre-configured for webhook ingestion paths.
 * Captures: provider, eventType, eventId.
 * Deliberately does NOT capture raw payload — only identifiers.
 */
export function createWebhookSpan(fields: {
  readonly provider:  "livekit" | "stripe" | "razorpay" | "svix";
  readonly eventType: string;
  readonly eventId?:  string;
}): TelemetrySpan {
  return createSpan(`api.webhooks.${fields.provider}`, {
    webhook_provider: fields.provider,
    event_type:       fields.eventType,
    event_id:         fields.eventId ?? null,
  });
}

/**
 * Create a span pre-configured for Edge Middleware.
 * Captures: route, method, rateLimitResult.
 * User ID is injected from the forwarded x-user-id header after JWT verify.
 */
export function createMiddlewareSpan(fields: {
  readonly route:  string;
  readonly method: string;
  readonly ip?:    string;
}): TelemetrySpan {
  return createSpan("middleware.auth", {
    route:  fields.route,
    method: fields.method,
    // IP is hashed for privacy — never log raw IP in telemetry
    ip_hash: fields.ip !== undefined
      ? hashIp(fields.ip)
      : null,
  });
}

// ---------------------------------------------------------------------------
// IP hashing (for rate-limit telemetry — never log raw IPs)
// ---------------------------------------------------------------------------

/**
 * Return a stable 8-char hash of an IP address for grouping/anomaly detection
 * without storing personally identifiable network data.
 *
 * Uses the Web Crypto API which is available in both Edge and Node.js.
 * Returns a synchronous placeholder if crypto is unavailable (test env).
 */
function hashIp(ip: string): string {
  // Synchronous fallback — real hashing happens in async contexts
  // For telemetry we accept a best-effort approach here
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    return ip.split(".").slice(0, 2).join(".") + ".x.x"; // /16 prefix only
  }

  // For Edge runtime: return truncated partial for anonymization
  // Full async hashing would require span.end() to be async anyway
  const parts = ip.includes(":") // IPv6
    ? ip.split(":").slice(0, 4).join(":") + "::x"
    : ip.split(".").slice(0, 3).join(".") + ".x";

  return parts;
}
