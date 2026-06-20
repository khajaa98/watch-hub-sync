/**
 * src/app/(auth)/layout.tsx
 *
 * Auth route group layout.
 * Renders unauthenticated surfaces: /login, /auth/callback.
 *
 * Design: full-viewport centered shell with a fixed cinematic background.
 * No navigation bar — maximum focus on the authentication action.
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
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-canvas px-4">
      {/* Ambient background — two radial gradients for depth */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        {/* Top-left accent bloom */}
        <div className="absolute -left-64 -top-64 h-[600px] w-[600px] rounded-full bg-accent/[0.06] blur-[120px]" />
        {/* Bottom-right counter bloom */}
        <div className="absolute -bottom-64 -right-32 h-[500px] w-[500px] rounded-full bg-violet-900/[0.08] blur-[100px]" />
        {/* Vignette */}
        <div className="absolute inset-0 bg-vignette" />
      </div>

      {/* Wordmark — top-left anchored */}
      <a
        href="/"
        className="absolute left-6 top-6 flex items-center gap-2 text-sm font-semibold text-neutral-300 transition-colors hover:text-white"
        aria-label="Watch Hub Sync home"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/20 text-xs font-bold text-accent ring-1 ring-inset ring-accent/20">
          W
        </span>
        <span className="hidden sm:inline">Watch Hub Sync</span>
      </a>

      {/* Page content */}
      <main className="relative z-10 w-full max-w-sm">
        {children}
      </main>

      {/* Footer */}
      <footer className="absolute bottom-6 text-center text-2xs text-neutral-700">
        <p>
          By signing in you agree to our{" "}
          <a href="/terms" className="text-neutral-500 underline underline-offset-2 hover:text-neutral-300 transition-colors">
            Terms
          </a>{" "}
          and{" "}
          <a href="/privacy" className="text-neutral-500 underline underline-offset-2 hover:text-neutral-300 transition-colors">
            Privacy Policy
          </a>
          .
        </p>
      </footer>
    </div>
  );
}
