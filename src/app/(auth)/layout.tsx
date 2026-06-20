/**
 * src/app/(auth)/layout.tsx
 *
 * Auth route group shell — theater-black canvas with ambient violet glow.
 * Handles full-viewport centering, wordmark, and legal footer.
 * The animated card is rendered by the page component.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    template: "%s — Watch Hub Sync",
    default: "Sign In — Watch Hub Sync",
  },
};

interface AuthLayoutProps {
  readonly children: React.ReactNode;
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-zinc-950 px-4">

      {/* ── Ambient lighting layer ──────────────────────────────────────────── */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
        {/* Primary radial glow — centered behind card */}
        <div className="absolute left-1/2 top-1/2 h-[700px] w-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-900/20 blur-[120px]" />
        {/* Secondary accent — top-left edge bloom */}
        <div className="absolute -left-48 -top-48 h-[500px] w-[500px] rounded-full bg-violet-800/10 blur-[100px]" />
        {/* Tertiary — bottom-right cooldown */}
        <div className="absolute -bottom-48 -right-24 h-[400px] w-[400px] rounded-full bg-indigo-900/10 blur-[100px]" />
        {/* Vignette — edges fall to pure black */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_50%,rgba(0,0,0,0.7)_100%)]" />
        {/* Subtle film-grain overlay */}
        <div
          className="absolute inset-0 opacity-[0.025] mix-blend-overlay"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
            backgroundSize: "256px 256px",
          }}
        />
      </div>

      {/* ── Wordmark ────────────────────────────────────────────────────────── */}
      <a
        href="/"
        className="absolute left-6 top-6 z-20 flex items-center gap-2.5 text-sm font-semibold text-zinc-400 transition-colors duration-150 hover:text-white"
        aria-label="Watch Hub Sync home"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/15 text-xs font-bold text-violet-400 ring-1 ring-inset ring-violet-500/25">
          W
        </span>
        <span className="hidden sm:inline tracking-tight">Watch Hub Sync</span>
      </a>

      {/* ── Page content (animated card injected here) ──────────────────────── */}
      <main className="relative z-10 w-full max-w-sm">
        {children}
      </main>

      {/* ── Legal footer ────────────────────────────────────────────────────── */}
      <footer className="absolute bottom-6 z-10 text-center text-[11px] text-zinc-700">
        <p>
          By signing in you agree to our{" "}
          <a
            href="/terms"
            className="text-zinc-600 underline underline-offset-2 transition-colors hover:text-zinc-400"
          >
            Terms
          </a>{" "}
          and{" "}
          <a
            href="/privacy"
            className="text-zinc-600 underline underline-offset-2 transition-colors hover:text-zinc-400"
          >
            Privacy Policy
          </a>
          .
        </p>
      </footer>
    </div>
  );
}
