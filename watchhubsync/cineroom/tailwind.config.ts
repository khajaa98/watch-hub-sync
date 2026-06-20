/**
 * tailwind.config.ts
 *
 * WatchHubSync cinematic design system.
 *
 * Design philosophy:
 *   Minimalist restraint. Dark-first. Every color decision serves legibility
 *   over aesthetic. Surfaces are layered by elevation (canvas → surface →
 *   overlay → raised) using luminosity increments of ~4% to create depth
 *   without noise. The single accent (violet) is reserved for interactive
 *   affordance only — never decoration.
 */

import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // ── Colors ──────────────────────────────────────────────────────────
      colors: {
        // Elevation-based surface system
        canvas:  "#0A0A0A", // page background — true near-black
        surface: {
          DEFAULT: "#111111", // base card surface
          raised:  "#161616", // modal, popover, elevated card
          overlay: "#1C1C1C", // dropdown, tooltip, contextual panels
          high:    "#222222", // focused/active surface state
        },
        // Accent — interactive affordance only (CTA, focus ring, link)
        accent: {
          DEFAULT:   "#7C3AED", // violet-600
          hover:     "#6D28D9", // violet-700
          subtle:    "rgba(124,58,237,0.10)",
          "subtle-hover": "rgba(124,58,237,0.16)",
          foreground: "#FFFFFF",
        },
        // Platform brand colours (used for platform identity badges)
        platform: {
          youtube:    "#FF0000",
          jiohotstar: "#1B69C6",
          netflix:    "#E50914",
          primevideo: "#00A8E1",
        },
        // Semantic states
        ok: {
          DEFAULT: "#10B981", // emerald-500
          subtle:  "rgba(16,185,129,0.10)",
          border:  "rgba(16,185,129,0.20)",
        },
        warn: {
          DEFAULT: "#F59E0B", // amber-500
          subtle:  "rgba(245,158,11,0.10)",
          border:  "rgba(245,158,11,0.20)",
        },
        danger: {
          DEFAULT: "#EF4444", // red-500
          subtle:  "rgba(239,68,68,0.10)",
          border:  "rgba(239,68,68,0.20)",
        },
      },

      // ── Typography ──────────────────────────────────────────────────────
      fontFamily: {
        sans: [
          "var(--font-geist-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: [
          "var(--font-geist-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "1rem" }],
      },
      letterSpacing: {
        "display": "-0.03em",
        "tighter-2": "-0.04em",
      },

      // ── Spacing & Geometry ──────────────────────────────────────────────
      borderRadius: {
        "4xl": "2rem",
        "5xl": "2.5rem",
      },

      // ── Shadows ─────────────────────────────────────────────────────────
      boxShadow: {
        "glow-accent":  "0 0 24px rgba(124,58,237,0.20), 0 0 8px rgba(124,58,237,0.12)",
        "glow-ok":      "0 0 16px rgba(16,185,129,0.20)",
        "glow-warn":    "0 0 16px rgba(245,158,11,0.20)",
        "glow-danger":  "0 0 16px rgba(239,68,68,0.20)",
        "card":         "0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05)",
        "card-hover":   "0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)",
        "modal":        "0 24px 64px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.06)",
        "inner-top":    "inset 0 1px 0 rgba(255,255,255,0.06)",
      },

      // ── Backgrounds ─────────────────────────────────────────────────────
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":  "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        // Subtle vignette overlay for cinema feel
        "vignette":
          "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.6) 100%)",
        // Noise grain texture (base64 SVG — lightweight)
        "noise":
          "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E\")",
      },

      // ── Animations ──────────────────────────────────────────────────────
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to:   { opacity: "1" },
        },
        "fade-out": {
          from: { opacity: "1" },
          to:   { opacity: "0" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "slide-down": {
          from: { opacity: "0", transform: "translateY(-8px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to:   { opacity: "1", transform: "scale(1)" },
        },
        "ping-soft": {
          "0%, 100%": { transform: "scale(1)",    opacity: "1" },
          "50%":      { transform: "scale(1.08)", opacity: "0.7" },
        },
        "shimmer": {
          from: { backgroundPosition: "200% 0" },
          to:   { backgroundPosition: "-200% 0" },
        },
        "pulse-ring": {
          "0%":   { transform: "scale(0.95)", boxShadow: "0 0 0 0 rgba(124,58,237,0.4)" },
          "70%":  { transform: "scale(1)",    boxShadow: "0 0 0 8px rgba(124,58,237,0)" },
          "100%": { transform: "scale(0.95)", boxShadow: "0 0 0 0 rgba(124,58,237,0)" },
        },
      },
      animation: {
        "fade-in":    "fade-in 0.2s ease-out",
        "fade-out":   "fade-out 0.15s ease-in",
        "slide-up":   "slide-up 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-down": "slide-down 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-in":   "scale-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
        "ping-soft":  "ping-soft 2s ease-in-out infinite",
        "shimmer":    "shimmer 2.4s linear infinite",
        "pulse-ring": "pulse-ring 2s cubic-bezier(0.455, 0.03, 0.515, 0.955) infinite",
      },

      // ── Transitions ─────────────────────────────────────────────────────
      transitionTimingFunction: {
        "spring":      "cubic-bezier(0.16, 1, 0.3, 1)",
        "spring-hard": "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
      transitionDuration: {
        "250": "250ms",
        "350": "350ms",
        "450": "450ms",
      },
    },
  },
  plugins: [],
};

export default config;
