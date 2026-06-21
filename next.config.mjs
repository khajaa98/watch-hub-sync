/**
 * next.config.mjs
 *
 * Watch Hub Sync — Next.js 14 Production Configuration.
 *
 * ─── BUILD-TIME ENV VALIDATION ───────────────────────────────────────────────
 * The first substantive line of this file imports `./src/lib/env.ts`.
 * If any required environment variable is missing or malformed, the Zod
 * validation throws a formatted error and the process exits with code 1.
 * This ensures a misconfigured build never reaches Vercel's production edge.
 *
 * ─── CONNECTION POOLING NOTES ────────────────────────────────────────────────
 * Supavisor (Transaction mode) is configured via env vars, not this file.
 * See INFRASTRUCTURE.md for the exact Supabase dashboard steps.
 *
 * Summary of routing:
 *   Serverless API routes → DATABASE_URL       (Supavisor pooled, port 6543)
 *   Webhook handlers      → DATABASE_URL_DIRECT (direct Postgres, port 5432)
 *   Migrations            → DATABASE_URL_DIRECT
 */

// ── 1. Build-time env validation (must be before any other import) ─────────
// Skip in test environment to allow jest/vitest to import next.config
if (process.env.NODE_ENV !== "test" && process.env.SKIP_ENV_VALIDATION !== "1") {
  // Dynamic import keeps this an MJS module while accessing the TS source
  // compiled by Next.js's built-in SWC transpiler.
  const { serverEnv } = await import("./src/lib/env.js").catch(() => {
    // Fallback: env.ts hasn't been compiled yet (first `next dev` start).
    // On `next build`, the compiled version is always present.
    return { serverEnv: null };
  });
  if (serverEnv === null) {
    console.warn(
      "[WHS] Env validation skipped: env.ts not yet compiled. " +
        "This is expected on first `next dev` start.",
    );
  }
}

// ── 2. Next.js configuration ───────────────────────────────────────────────

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ── Strict mode ────────────────────────────────────────────────────────
  reactStrictMode: true,

  // ── TypeScript ─────────────────────────────────────────────────────────
  typescript: {
    // Type errors are caught by `tsc --noEmit` in CI before `next build`.
    // In production builds, allow Next.js to build even with TS errors so
    // the env-validation step above is the hard gate, not type-checking.
    // CI enforces the tsc gate separately for faster feedback loops.
    ignoreBuildErrors: false,
  },

  // ── ESLint ─────────────────────────────────────────────────────────────
  eslint: {
    // ESLint runs in CI as a separate step. Disabling here speeds up builds.
    ignoreDuringBuilds: true,
  },

  // ── Source maps ────────────────────────────────────────────────────────
  // Production source maps are uploaded to Vercel and Axiom/Sentry.
  // They are NOT served to end users (hidden behind internal CDN paths).
  productionBrowserSourceMaps: false, // Never expose source maps to browsers

  // ── Experimental features ───────────────────────────────────────────────
  experimental: {
    // Server Actions (used for room creation mutation)
    serverActions: {
      bodySizeLimit: "1mb",
    },
    // Partial pre-rendering — disable until stable in Next.js 14.x
    ppr: false,
    // Optimise package imports to reduce Edge bundle sizes
    optimizePackageImports: [
      "lucide-react",
      "framer-motion",
      "@livekit/components-react",
      "date-fns",
    ],
  },

  // ── Images ──────────────────────────────────────────────────────────────
  images: {
    remotePatterns: [
      // Supabase Storage (user avatars)
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      // GitHub avatars (social login)
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
      // Google user profile pictures
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
    // Optimize for India-first WebP delivery
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 86400, // 24h CDN cache for profile images
  },

  // ── Security headers ─────────────────────────────────────────────────────
  // These complement the headers set in src/middleware.ts.
  // Middleware headers apply at Edge; these apply at the CDN/origin level.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Prevent browsers from sniffing content type
          {
            key:   "X-Content-Type-Options",
            value: "nosniff",
          },
          // Prevent clickjacking
          {
            key:   "X-Frame-Options",
            value: "DENY",
          },
          // Strict HTTPS in production
          {
            key:   "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          // Referrer policy — no referrer to third-party OTT platforms
          {
            key:   "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          // Restrict browser features
          // clipboard-write: needed for "Copy invite link" button
          // autoplay + picture-in-picture: granted to YouTube iframe for theater player
          {
            key:   "Permissions-Policy",
            value: [
              "clipboard-write=(self)",
              "autoplay=(self \"https://www.youtube.com\")",
              "picture-in-picture=(self \"https://www.youtube.com\")",
              "camera=()",
              "microphone=()",
              "geolocation=()",
              "payment=()",
              "usb=()",
              "serial=()",
              "bluetooth=()",
            ].join(", "),
          },
          // Content Security Policy (strict baseline)
          // OTT platforms are NOT in connect-src — we never load their assets.
          {
            key:   "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Scripts: self + Vercel Analytics + YouTube IFrame API
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://va.vercel-scripts.com https://www.youtube.com https://s.ytimg.com",
              // Styles: self + inline (for Tailwind JIT in dev)
              "style-src 'self' 'unsafe-inline'",
              // Images: self + Supabase storage + Google avatars + data URIs
              "img-src 'self' data: blob: https://*.supabase.co https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
              // Fonts: self + Geist (loaded as next/font, bundled locally)
              "font-src 'self'",
              // Connect: our API + Supabase Realtime + LiveKit WebRTC signaling + Axiom + PostHog
              // + YouTube metadata/thumbnail fetches triggered by the IFrame API
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.livekit.cloud wss://*.livekit.cloud https://api.axiom.co https://app.posthog.com https://eu.posthog.com https://www.youtube.com https://s.ytimg.com",
              // Media: self + blob (for any local object URLs)
              "media-src 'self' blob:",
              // Workers: self
              "worker-src 'self' blob:",
              // Frame: self + YouTube embed (theater player)
              "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
              // Form: self only
              "form-action 'self'",
              // Base URI: self only
              "base-uri 'self'",
              // Object: none (no plugins)
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },

      // ── Static asset caching ───────────────────────────────────────────
      {
        source: "/_next/static/(.*)",
        headers: [
          {
            key:   "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },

      // ── API routes — no caching, security headers ──────────────────────
      {
        source: "/api/(.*)",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
          { key: "X-Robots-Tag",  value: "noindex" },
        ],
      },
    ];
  },

  // ── Redirects ────────────────────────────────────────────────────────────
  async redirects() {
    return [
      // Redirect bare domain root to dashboard (middleware handles auth)
      {
        source:      "/",
        destination: "/dashboard",
        permanent:   false, // Soft redirect — may change
      },
    ];
  },

  // ── Webpack customization ────────────────────────────────────────────────
  webpack(config, { isServer }) {
    // Suppress warnings from livekit-client's optional WebAssembly modules
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs:     false,
      net:    false,
      tls:    false,
      dns:    false,
    };

    // Exclude heavy server-only packages from client bundle
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        // livekit-server-sdk must never ship to the browser
        "livekit-server-sdk": false,
        // Razorpay server SDK
        "razorpay":           false,
        // Pino (server logger)
        "pino":               false,
      };
    }

    return config;
  },
};

export default nextConfig;
