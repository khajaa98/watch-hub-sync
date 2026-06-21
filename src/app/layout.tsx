/**
 * src/app/layout.tsx
 *
 * Watch Hub Sync — Root Application Layout.
 *
 * Render order (top → bottom, outermost → innermost):
 *
 *   <html dark>
 *     <head>
 *       DNS preconnect hints (Supabase, PostHog, LiveKit)
 *     </head>
 *     <body GeistSans + GeistMono fonts>
 *       <PHProvider>        ← PostHog context (client — deferred idle init)
 *         <PostHogPageview> ← App Router navigation tracking (Suspense-wrapped)
 *         {children}        ← Page content
 *       </PHProvider>
 *       <Analytics />       ← Vercel Analytics (async, 1KB inline script)
 *       <SpeedInsights />   ← Vercel Speed Insights (async, Core Web Vitals)
 *     </body>
 *   </html>
 *
 * Performance guarantees:
 *   - No render-blocking scripts
 *   - PHProvider defers PostHog init to requestIdleCallback (post-LCP)
 *   - Vercel Analytics and SpeedInsights use async script injection
 *   - Fonts are loaded via next/font (zero layout shift, inlined CSS vars)
 *   - Preconnect hints reduce DNS lookup time for third-party origins
 */

import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Analytics }    from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { PHProvider, PostHogPageview } from "@/providers/posthog-provider";
import "./globals.css";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env["NEXT_PUBLIC_APP_URL"] ?? "https://watchhubsync.online",
  ),

  title: {
    default:  "Watch Hub Sync",
    template: "%s — Watch Hub Sync",
  },

  description:
    "India's first cinema-grade watch-together platform. " +
    "Synchronized streaming with zero-proxy DRM compliance.",

  keywords: [
    "watch together",
    "watch party",
    "sync streaming",
    "India streaming",
    "JioHotstar sync",
    "YouTube watch party",
  ],

  authors: [{ name: "Watch Hub Sync" }],

  openGraph: {
    type:        "website",
    siteName:    "Watch Hub Sync",
    title:       "Watch Hub Sync — Cinema, Together.",
    description: "Synchronized streaming across any OTT platform. India-first.",
    images: [
      {
        url:    "/og/default.png",
        width:  1200,
        height: 630,
        alt:    "Watch Hub Sync",
      },
    ],
  },

  twitter: {
    card:  "summary_large_image",
    site:  "@watchhubsync",
    title: "Watch Hub Sync",
  },

  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32",        type: "image/x-icon" },
    ],
    shortcut: "/favicon.ico",
  },

  robots: {
    index:  true,
    follow: true,
    googleBot: {
      index:  true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
    },
  },
};

export const viewport: Viewport = {
  themeColor:   "#0A0A0A",
  colorScheme:  "dark",
  width:        "device-width",
  initialScale: 1,
  minimumScale: 1,
  viewportFit:  "cover",
};

// ---------------------------------------------------------------------------
// Root Layout
// ---------------------------------------------------------------------------

interface RootLayoutProps {
  readonly children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} dark`}
      suppressHydrationWarning
      // suppressHydrationWarning: prevents React hydration mismatch warnings
      // caused by browser extensions (LastPass, Grammarly) modifying the DOM.
    >
      <head>
        {/*
         * ── DNS Preconnect Hints ─────────────────────────────────────────
         *
         * Instruct the browser to open TCP + TLS connections to these origins
         * BEFORE they're actually needed. Saves 150–300ms per origin on first
         * request in India's variable network conditions.
         *
         * crossOrigin="anonymous": required for CORS-restricted origins.
         */}

        {/* Supabase: auth, database, realtime */}
        <link
          rel="preconnect"
          href={process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "https://supabase.co"}
        />

        {/* PostHog: event ingestion endpoint */}
        <link
          rel="preconnect"
          href={
            process.env["NEXT_PUBLIC_POSTHOG_HOST"] ?? "https://app.posthog.com"
          }
          crossOrigin="anonymous"
        />

        {/*
         * LiveKit: WebSocket signaling.
         * preconnect uses the https:// form — the browser handles the wss://
         * upgrade transparently since they share the same TCP/TLS endpoint.
         */}
        {process.env["NEXT_PUBLIC_LIVEKIT_URL"] !== undefined && (
          <link
            rel="preconnect"
            href={process.env["NEXT_PUBLIC_LIVEKIT_URL"].replace(
              "wss://",
              "https://",
            )}
            crossOrigin="anonymous"
          />
        )}

        {/* DNS prefetch only (cheaper than preconnect) for Vercel CDN */}
        <link rel="dns-prefetch" href="https://va.vercel-scripts.com" />
      </head>

      <body
        className={[
          "min-h-dvh bg-canvas font-sans antialiased",
          "selection:bg-accent/30 selection:text-white",
        ].join(" ")}
      >
        {/*
         * PHProvider must be the outermost client boundary so that
         * `usePostHog()` is available in all client components.
         *
         * PostHogPageview sits INSIDE the provider (needs posthog context)
         * but OUTSIDE {children} so navigation events fire on every route
         * regardless of what the page renders.
         */}
        <PHProvider>
          <PostHogPageview />
          {children}
        </PHProvider>

        {/* Vercel Analytics — pageview tracking + Core Web Vitals */}
        <Analytics />

        {/* Vercel Speed Insights — LCP, INP, CLS, FID, FCP, TTFB */}
        <SpeedInsights />
      </body>
    </html>
  );
}
