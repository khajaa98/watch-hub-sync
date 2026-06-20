# CineRoom — Project Directory Structure

> **Architecture**: Next.js 14 App Router · Supabase · LiveKit · Stripe/Razorpay · Vercel Edge
> **Convention**: Feature-colocated modules. Shared primitives live in `src/lib`. Route segments follow the App Router convention.

```
cineroom/
├── .env.local                          # Local secrets (never committed)
├── .env.example                        # Schema for required env vars
├── .eslintrc.json                      # ESLint config (Next.js + TS + Tailwind)
├── .prettierrc                         # Prettier config
├── .husky/                             # Git hooks (pre-commit lint+format)
├── next.config.ts                      # Next.js config (CSP headers, image domains)
├── tailwind.config.ts                  # Tailwind theme (cinema dark palette)
├── tsconfig.json                       # TypeScript strict mode
├── postcss.config.js
├── vitest.config.ts                    # Unit/integration test config
├── package.json
│
├── supabase/
│   ├── config.toml                     # Supabase local dev config
│   └── migrations/
│       ├── 00001_create_enums.sql      # Enum types (platform, tier, role, status)
│       ├── 00002_create_users.sql      # users table + RLS
│       ├── 00003_create_rooms.sql      # rooms table + RLS
│       ├── 00004_create_participants.sql  # participants table + RLS
│       ├── 00005_create_billing.sql    # billing_meters table + RLS
│       └── 00006_create_indexes.sql    # Composite & partial performance indexes
│
├── public/
│   ├── fonts/                          # Self-hosted variable fonts (Geist, etc.)
│   ├── og/                             # Open Graph image templates
│   └── icons/                         # SVG sprite, favicon set
│
└── src/
    ├── app/                            # Next.js App Router root
    │   ├── layout.tsx                  # Root layout (fonts, analytics, query client)
    │   ├── page.tsx                    # Landing page (/)
    │   ├── globals.css                 # Tailwind base + CSS custom properties
    │   │
    │   ├── (auth)/                     # Auth route group (no shared nav)
    │   │   ├── login/
    │   │   │   └── page.tsx            # Email OTP + Passkey login
    │   │   └── callback/
    │   │       └── route.ts            # Supabase OAuth/OTP callback handler
    │   │
    │   ├── (app)/                      # Authenticated app shell
    │   │   ├── layout.tsx              # App shell layout (session guard)
    │   │   ├── dashboard/
    │   │   │   └── page.tsx            # Host dashboard — room list + creation CTA
    │   │   ├── rooms/
    │   │   │   ├── new/
    │   │   │   │   └── page.tsx        # Room creation form + geo-compat checker
    │   │   │   └── [roomId]/
    │   │   │       ├── page.tsx        # Room lobby/watch page
    │   │   │       └── remote/
    │   │   │           └── page.tsx    # Mobile remote control (dual-device pairing)
    │   │   └── billing/
    │   │       └── page.tsx            # Billing history + subscription management
    │   │
    │   └── api/                        # API routes (serverless / edge)
    │       ├── auth/
    │       │   └── passkey/
    │       │       └── route.ts        # FIDO2 passkey registration/authentication
    │       ├── rooms/
    │       │   ├── route.ts            # POST /api/rooms — create room
    │       │   └── [roomId]/
    │       │       ├── invite/
    │       │       │   └── route.ts    # POST — generate signed magic link / QR
    │       │       └── close/
    │       │           └── route.ts    # POST — close room, trigger billing finalize
    │       ├── livekit/
    │       │   ├── token/
    │       │   │   └── route.ts        # POST — mint scoped LiveKit JWT
    │       │   └── webhook/
    │       │       └── route.ts        # POST — LiveKit room_finished webhook → billing
    │       ├── billing/
    │       │   ├── stripe/
    │       │   │   └── webhook/
    │       │   │       └── route.ts    # POST — Stripe signed webhook handler
    │       │   └── razorpay/
    │       │       └── webhook/
    │       │           └── route.ts    # POST — Razorpay signed webhook handler
    │       └── geo/
    │           └── check/
    │               └── route.ts        # GET — IP geo-lookup for compat checker
    │
    ├── components/
    │   ├── ui/                         # Headless + styled primitives
    │   │   ├── button.tsx
    │   │   ├── card.tsx
    │   │   ├── dialog.tsx
    │   │   ├── input.tsx
    │   │   ├── select.tsx
    │   │   ├── switch.tsx
    │   │   ├── toast.tsx
    │   │   ├── tooltip.tsx
    │   │   └── badge.tsx
    │   │
    │   ├── layout/
    │   │   ├── nav.tsx                 # Top navigation bar
    │   │   └── footer.tsx
    │   │
    │   ├── landing/
    │   │   ├── hero.tsx                # Hero section with motion
    │   │   ├── features.tsx            # Feature grid
    │   │   └── cta.tsx                 # Conversion CTA strip
    │   │
    │   ├── room/
    │   │   ├── room-creator.tsx        # Multi-step room creation form
    │   │   ├── geo-compat-banner.tsx   # Smart geo-compatibility warning
    │   │   ├── invite-panel.tsx        # QR code + magic link share panel
    │   │   ├── participant-list.tsx    # Live participant roster
    │   │   ├── sync-status.tsx         # Sync health indicator
    │   │   └── remote-control.tsx      # Mobile remote UI (reactions + chat)
    │   │
    │   ├── chat/
    │   │   ├── chat-panel.tsx          # Real-time chat sidebar
    │   │   ├── message-bubble.tsx
    │   │   └── reaction-bar.tsx        # Emoji reaction overlay
    │   │
    │   └── billing/
    │       ├── plan-card.tsx           # Subscription tier display
    │       └── usage-meter.tsx         # Participant-minutes consumption
    │
    ├── lib/
    │   ├── supabase/
    │   │   ├── client.ts               # Browser-side Supabase client (singleton)
    │   │   ├── server.ts               # Server-side Supabase client (cookies)
    │   │   ├── middleware.ts           # Session refresh middleware helper
    │   │   └── queries/
    │   │       ├── rooms.ts            # Typed room CRUD queries
    │   │       ├── participants.ts     # Participant queries
    │   │       └── billing.ts          # Billing meter queries
    │   │
    │   ├── livekit/
    │   │   ├── server.ts               # Token minting + room management API
    │   │   └── webhook.ts              # Webhook signature verification
    │   │
    │   ├── payments/
    │   │   ├── stripe.ts               # Stripe SDK singleton + helpers
    │   │   └── razorpay.ts             # Razorpay SDK singleton + helpers
    │   │
    │   ├── geo/
    │   │   └── checker.ts              # IP geolocation + platform compat logic
    │   │
    │   ├── invite/
    │   │   └── magic-link.ts           # HMAC-signed magic link generation/verify
    │   │
    │   ├── rate-limit/
    │   │   └── upstash.ts              # Upstash Redis rate limiter factory
    │   │
    │   ├── logger/
    │   │   └── index.ts                # Pino structured logger (edge-safe)
    │   │
    │   └── utils.ts                    # cn(), formatDuration(), shared utils
    │
    ├── hooks/
    │   ├── use-session.ts              # Supabase auth session hook
    │   ├── use-room.ts                 # Room state + LiveKit connection hook
    │   ├── use-sync.ts                 # OTT adapter message listener hook
    │   ├── use-participants.ts         # Real-time participant list hook
    │   ├── use-chat.ts                 # LiveKit data channel chat hook
    │   └── use-geo-check.ts            # Client-side geo compat check hook
    │
    ├── adapters/                       # Client-side OTT video sync adapters
    │   ├── base-adapter.ts             # Abstract OTTAdapter interface
    │   ├── youtube-adapter.ts          # YouTube iframe/video event bridge
    │   └── hotstar-adapter.ts          # JioHotstar video event bridge
    │
    ├── types/
    │   ├── supabase.ts                 # Auto-generated Supabase DB types
    │   ├── livekit.ts                  # LiveKit data message type contracts
    │   ├── room.ts                     # Domain types (Room, Participant, etc.)
    │   ├── billing.ts                  # Billing domain types
    │   └── api.ts                      # API request/response schemas (Zod)
    │
    └── middleware.ts                   # Next.js edge middleware (session + rate-limit)
```
