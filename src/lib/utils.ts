/**
 * src/lib/utils.ts
 *
 * Shared, pure utility functions for WatchHubSync.
 * Tree-shakeable — every export is a named function.
 * No side effects, no external I/O.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// ---------------------------------------------------------------------------
// Tailwind class merge helper
// ---------------------------------------------------------------------------

/**
 * Merges Tailwind CSS class names, resolving conflicts.
 * Standard Shadcn/ui pattern — safe to use anywhere.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Duration utilities
// ---------------------------------------------------------------------------

/**
 * Format a duration in seconds to a human-readable string.
 * e.g. 3670 → "1h 1m 10s"
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 0) return "0s";

  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);

  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return parts.join(" ");
}

/**
 * Convert a duration in seconds to participant-minutes (ceiling per participant).
 * Matches the billing_meters formula exactly.
 */
export function toParticipantMinutes(durationSeconds: number): number {
  return Math.ceil(durationSeconds / 60);
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Return the UTC billing period boundaries (month start/end) for a given date.
 */
export function getBillingPeriod(date: Date): {
  start: Date;
  end: Date;
} {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999),
  );
  return { start, end };
}

// ---------------------------------------------------------------------------
// Crypto utilities (Edge-safe — Web Crypto API only)
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure random hex string.
 * Uses the Web Crypto API, available on both Node.js 20+ and V8 edge isolates.
 */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Use when comparing HMAC digests or tokens.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    // Non-null assertion safe: i < aBytes.length === bBytes.length
    diff |= (aBytes[i] as number) ^ (bBytes[i] as number);
  }

  return diff === 0;
}

/**
 * Encode a Uint8Array as a URL-safe base64 string (base64url, no padding).
 * Used for WebAuthn challenge encoding and invite token hashing.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a base64url string back to Uint8Array.
 */
export function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// URL / routing utilities
// ---------------------------------------------------------------------------

/**
 * Build an absolute URL using the app's canonical origin.
 * Falls back to a relative URL in environments where NEXT_PUBLIC_APP_URL is unset.
 */
export function absoluteUrl(path: string): string {
  const base =
    process.env["NEXT_PUBLIC_APP_URL"] ??
    (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}${path}`;
}

// ---------------------------------------------------------------------------
// Type narrowing utilities
// ---------------------------------------------------------------------------

/**
 * Assert that a value is non-null and non-undefined.
 * Throws at runtime in addition to narrowing at compile time.
 */
export function assertDefined<T>(
  value: T | null | undefined,
  label: string,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(`Expected defined value for "${label}", got ${String(value)}`);
  }
}

/**
 * Type-safe object entries — preserves key literal types.
 */
export function typedEntries<T extends Record<string, unknown>>(
  obj: T,
): [keyof T, T[keyof T]][] {
  return Object.entries(obj) as [keyof T, T[keyof T]][];
}
