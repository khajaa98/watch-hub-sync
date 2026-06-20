/**
 * src/lib/logger/index.ts
 *
 * Edge-safe structured logger for WatchHubSync.
 *
 * Strategy:
 *   - Node.js runtime (Server Components, Route Handlers, API):
 *       Delegates to Pino for structured JSON output + pretty-printing in dev.
 *   - Edge runtime (Middleware, Edge Functions):
 *       Falls back to structured console output using the same interface,
 *       since Pino's transport layer is not available in V8 isolates.
 *
 * Usage:
 *   import { logger } from '@/lib/logger'
 *   logger.info({ roomId }, 'Room created')
 *   logger.error({ err, userId }, 'Auth failure')
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface Logger {
  trace(ctx: LogContext, msg: string): void;
  trace(msg: string): void;
  debug(ctx: LogContext, msg: string): void;
  debug(msg: string): void;
  info(ctx: LogContext, msg: string): void;
  info(msg: string): void;
  warn(ctx: LogContext, msg: string): void;
  warn(msg: string): void;
  error(ctx: LogContext, msg: string): void;
  error(msg: string): void;
  fatal(ctx: LogContext, msg: string): void;
  fatal(msg: string): void;
  child(bindings: LogContext): Logger;
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

const isEdgeRuntime =
  typeof process === "undefined" ||
  (typeof process !== "undefined" &&
    // Next.js sets NEXT_RUNTIME to "edge" in middleware and edge functions.
    process.env["NEXT_RUNTIME"] === "edge");

const resolvedLevel: LogLevel =
  (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info";

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

// ---------------------------------------------------------------------------
// Edge Logger — structured JSON over console, same interface as Pino.
// ---------------------------------------------------------------------------

function makeEdgeLogger(bindings: LogContext = {}): Logger {
  const rank = LEVEL_RANK[resolvedLevel] ?? 30;

  function emit(level: LogLevel, ctxOrMsg: LogContext | string, msg?: string): void {
    if ((LEVEL_RANK[level] ?? 0) < rank) return;

    const [ctx, message] =
      typeof ctxOrMsg === "string"
        ? [{}, ctxOrMsg]
        : [ctxOrMsg, msg ?? ""];

    const entry = JSON.stringify({
      level,
      time: new Date().toISOString(),
      ...bindings,
      ...ctx,
      msg: message,
    });

    if (level === "error" || level === "fatal") {
      console.error(entry);
    } else if (level === "warn") {
      console.warn(entry);
    } else {
      console.log(entry);
    }
  }

  return {
    trace: (ctxOrMsg: LogContext | string, msg?: string) =>
      emit("trace", ctxOrMsg as LogContext | string, msg),
    debug: (ctxOrMsg: LogContext | string, msg?: string) =>
      emit("debug", ctxOrMsg as LogContext | string, msg),
    info: (ctxOrMsg: LogContext | string, msg?: string) =>
      emit("info", ctxOrMsg as LogContext | string, msg),
    warn: (ctxOrMsg: LogContext | string, msg?: string) =>
      emit("warn", ctxOrMsg as LogContext | string, msg),
    error: (ctxOrMsg: LogContext | string, msg?: string) =>
      emit("error", ctxOrMsg as LogContext | string, msg),
    fatal: (ctxOrMsg: LogContext | string, msg?: string) =>
      emit("fatal", ctxOrMsg as LogContext | string, msg),
    child: (childBindings: LogContext) =>
      makeEdgeLogger({ ...bindings, ...childBindings }),
  };
}

// ---------------------------------------------------------------------------
// Node.js Logger — Pino with pretty-printing in development.
// Lazy-imported to prevent bundling into the edge runtime.
// ---------------------------------------------------------------------------

function makeNodeLogger(): Logger {
  // Dynamic require keeps Pino out of the edge bundle.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pino = require("pino") as typeof import("pino");

  const isDev = process.env["NODE_ENV"] !== "production";

  const pinoInstance = pino.default({
    level: resolvedLevel,
    ...(isDev
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:HH:MM:ss.l",
              ignore: "pid,hostname",
            },
          },
        }
      : {
          formatters: {
            level(label: string) {
              return { level: label };
            },
          },
          timestamp: pino.default.stdTimeFunctions.isoTime,
          messageKey: "msg",
        }),
  });

  // Pino's interface is compatible with ours — cast is safe.
  return pinoInstance as unknown as Logger;
}

// ---------------------------------------------------------------------------
// Export — consumers always import this singleton.
// ---------------------------------------------------------------------------

export const logger: Logger = isEdgeRuntime
  ? makeEdgeLogger()
  : makeNodeLogger();

/**
 * Create a child logger with pre-bound fields.
 * Prefer this over passing ctx to every call inside a module/route.
 *
 * Example:
 *   const log = createLogger({ module: 'livekit.webhook' })
 *   log.info({ roomId }, 'Processing room_finished')
 */
export function createLogger(bindings: LogContext): Logger {
  return logger.child(bindings);
}
