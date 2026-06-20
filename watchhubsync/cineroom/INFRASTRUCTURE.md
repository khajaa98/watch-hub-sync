# Watch Hub Sync — Production Infrastructure Brief

This document is the authoritative pre-launch checklist. Complete every item in order. Nothing ships until every checkbox is ticked.

---

## 1. Supabase Production Setup

### 1.1 Project Settings

| Setting | Value |
|---------|-------|
| Region | `ap-south-1` (Mumbai) — India-first latency |
| Postgres version | 15.x (minimum) |
| Database password | 32+ random chars, stored in 1Password |

### 1.2 Point-in-Time Recovery (PITR) — MANDATORY

PITR enables recovery to any second in the past. Required before handling any financial data.

**Steps:**
1. Supabase Dashboard → Project → **Settings** → **Database**
2. Scroll to **Point in Time Recovery**
3. Click **Enable PITR**
4. Select retention: **7 days** minimum (30 days recommended for billing disputes)
5. Confirm the storage cost acknowledgement

> **Why:** The `billing_meters` table is write-once, append-only. If corrupted data is written (e.g., a bug in the LiveKit webhook), PITR lets you restore to before the incident without data loss.

### 1.3 Supavisor Connection Pooler (Transaction Mode)

Serverless Next.js functions open a new Postgres connection on every invocation. Without pooling, 100 concurrent API requests = 100 simultaneous connections, exhausting Supabase's limit (typically 60–200 direct connections depending on plan).

**Supavisor** runs as a sidecar pooler. Transaction mode releases connections back to the pool after each statement, making it safe for serverless.

**Enable Steps:**
1. Supabase Dashboard → Project → **Settings** → **Database**
2. Under **Connection pooling**, toggle **Enable connection pooling** → ON
3. Set **Pool Mode** to `Transaction`
4. Note the pooler connection string — it will look like:
   ```
   postgresql://postgres.[project-ref]:[password]@[region].pooler.supabase.com:6543/postgres
   ```

**Two connection strings to record:**

```bash
# Supavisor pooled — use for all API routes (short-lived queries)
DATABASE_URL=postgresql://postgres.[ref]:[pass]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres

# Direct Postgres — use for webhooks, migrations, LISTEN/NOTIFY
DATABASE_URL_DIRECT=postgresql://postgres:[pass]@db.[ref].supabase.com:5432/postgres
```

**Usage contract enforced in code (`src/lib/env.ts`):**

| Connection | Used In | Reason |
|-----------|---------|--------|
| `DATABASE_URL` (pooled) | All API routes, server components | Short transactions; no prepared statements needed |
| `DATABASE_URL_DIRECT` | `webhooks/livekit`, `webhooks/stripe`, `webhooks/razorpay`, migrations | Webhooks hold transactions open longer; direct avoids pooler timeout |

> **Transaction mode limitation:** Prepared statements, `SET LOCAL`, and `LISTEN` do not persist across pooled connections. All Supabase client code in this project uses parameterized queries via the PostgREST API — no raw prepared statements. This is safe.

### 1.4 Row Level Security Verification

Before launch, run this verification query on the production database:

```sql
-- Verify RLS is enabled on all application tables
SELECT
  schemaname,
  tablename,
  rowsecurity,
  forcerowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

Expected result: every table in the `public` schema shows `rowsecurity = true`.

```sql
-- Verify billing_meters is LOCKED to service_role only
-- This should return NO rows for 'anon' or 'authenticated' roles
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'billing_meters'
  AND grantee IN ('anon', 'authenticated');
```

Expected result: 0 rows (billing table is service_role only).

### 1.5 Database Indexes Verification

```sql
-- Verify all partial indexes from migration 00006 are present and active
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
```

Confirm these indexes exist:
- `idx_participants_active` — `WHERE left_at IS NULL`
- `idx_billing_meters_unprocessed` — `WHERE is_processed = FALSE`
- `idx_rooms_host_active` — `WHERE status IN ('waiting', 'active')`

---

## 2. Vercel Production Setup

### 2.1 Project Configuration

| Setting | Value |
|---------|-------|
| Framework | Next.js |
| Node.js version | 20.x |
| Root directory | `cineroom/` |
| Build command | `pnpm next build` |
| Output directory | `.next` |
| Install command | `pnpm install --frozen-lockfile` |

### 2.2 Edge Function Regions

Configure deployment to India-adjacent regions for lowest latency:

**Vercel Dashboard → Project → Settings → Functions → Regions**

Select:
- `sin1` — Singapore (closest to India, lowest latency for Indian users)
- `bom1` — Mumbai (if available in your Vercel plan; check availability)

Next.js Middleware runs globally on Vercel's Edge Network by default. The `sin1` region handles the majority of Indian traffic with ~40ms RTT.

### 2.3 Environment Variables

Set ALL of the following in **Vercel Dashboard → Project → Settings → Environment Variables**.

Set scope to **Production** + **Preview** separately. Never set `DATABASE_URL_DIRECT` in Preview (Preview should use a non-production Supabase project).

#### Supabase

| Variable | Example Format | Scope |
|----------|---------------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://[ref].supabase.co` | All |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` | All |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Production only |
| `SUPABASE_JWT_SECRET` | 32+ char random string | All |
| `DATABASE_URL` | Supavisor pooled URL | All |
| `DATABASE_URL_DIRECT` | Direct Postgres URL | Production only |

#### LiveKit

| Variable | Example Format | Scope |
|----------|---------------|-------|
| `LIVEKIT_URL` | `wss://[project].livekit.cloud` | All |
| `NEXT_PUBLIC_LIVEKIT_URL` | `wss://[project].livekit.cloud` | All |
| `LIVEKIT_API_KEY` | `APIxxxxxxxxxxxxxxxx` | Production |
| `LIVEKIT_API_SECRET` | 32+ char string | Production |

#### Stripe

| Variable | Example Format | Scope |
|----------|---------------|-------|
| `STRIPE_SECRET_KEY` | `sk_live_...` | Production only |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Production only |
| `STRIPE_PRICE_ID_PREMIUM` | `price_...` | Production |
| `STRIPE_METER_ID_PARTICIPANT_MINUTES` | `participant_minutes` | Production |

#### Razorpay

| Variable | Example Format | Scope |
|----------|---------------|-------|
| `RAZORPAY_KEY_ID` | `rzp_live_...` | Production only |
| `RAZORPAY_KEY_SECRET` | 32+ char string | Production only |
| `RAZORPAY_WEBHOOK_SECRET` | 32+ char string | Production only |
| `RAZORPAY_PLAN_ID_PREMIUM` | `plan_...` | Production |

#### Auth & Security

| Variable | Example Format | Scope |
|----------|---------------|-------|
| `SVIX_WEBHOOK_SECRET` | `whsec_...` | Production |
| `IRON_SESSION_SECRET` | 32+ char random string | All |
| `NEXT_PUBLIC_APP_URL` | `https://watchhubsync.com` | All |

#### Upstash Redis (rate limiting)

| Variable | Example Format | Scope |
|----------|---------------|-------|
| `UPSTASH_REDIS_REST_URL` | `https://[region].upstash.io` | All |
| `UPSTASH_REDIS_REST_TOKEN` | `AXxx...` | All |

#### Observability

| Variable | Example Format | Scope |
|----------|---------------|-------|
| `AXIOM_TOKEN` | `xaat-...` | All |
| `AXIOM_DATASET` | `watchhubsync-production` | Production |

### 2.4 Vercel Deployment Protection

**Vercel Dashboard → Project → Settings → Deployment Protection**

- Enable **Vercel Authentication** on Preview deployments (prevents public access to previews)
- Enable **Password Protection** on Preview as a secondary gate

---

## 3. LiveKit Production Setup

### 3.1 Project Creation

1. [LiveKit Cloud](https://cloud.livekit.io) → New Project → Region: `ap-south-1` (Mumbai)
2. Note the **WebSocket URL** (`wss://[project].livekit.cloud`)
3. Generate API Key + Secret → store in Vercel env vars

### 3.2 Webhook Configuration

**LiveKit Dashboard → Project → Settings → Webhooks**

Add endpoint:
```
URL: https://watchhubsync.com/api/webhooks/livekit
```

Enable these events ONLY (disable all others to reduce noise):
- `participant_joined`
- `participant_left` ← primary billing trigger
- `room_started`
- `room_finished` ← final billing sweep trigger

> **Security:** LiveKit signs webhooks with a JWT using your API secret. The `WebhookReceiver` in `src/app/api/webhooks/livekit/route.ts` verifies this before parsing any payload.

### 3.3 Room Configuration Defaults

In `src/app/api/rooms/route.ts` (to be implemented in a future phase), set these LiveKit room options:

```typescript
{
  maxParticipants: 50,          // Premium cap
  emptyTimeout:    300,         // 5 minutes before auto-close
  departureTimeout: 20,         // Seconds before participant_left fires
  metadata: JSON.stringify({ whs_room_id: roomId }),
}
```

---

## 4. Stripe Production Setup

### 4.1 Meter Configuration

Before creating the Premium Price, configure the Usage Meter:

**Stripe Dashboard → Billing → Meters → Create Meter**

| Field | Value |
|-------|-------|
| Name | `Participant Minutes` |
| Event Name | `participant_minutes` |
| Default Aggregation | `sum` |
| Customer Mapping | `stripe_customer_id` from payload |
| Value Settings | `value` field from payload |

Note the Meter ID (e.g., `mtrd_...`) → set as `STRIPE_METER_ID_PARTICIPANT_MINUTES`.

### 4.2 Premium Subscription Price

**Stripe Dashboard → Products → Create Product**

- Name: `Watch Hub Sync Premium`
- Pricing model: `Usage-based` (attached to the Participant Minutes meter)
- Billing period: Monthly
- Per-unit price: Set based on your pricing strategy (e.g., ₹0.50/minute after free tier)

Note the Price ID (e.g., `price_...`) → set as `STRIPE_PRICE_ID_PREMIUM`.

### 4.3 Webhook Endpoint

**Stripe Dashboard → Developers → Webhooks → Add Endpoint**

```
URL: https://watchhubsync.com/api/webhooks/stripe
```

Enable these events:
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `billing.meter_event_adjustment` (for future credit handling)

Click **Reveal** on the signing secret → set as `STRIPE_WEBHOOK_SECRET`.

---

## 5. Razorpay Production Setup

### 5.1 Plan Configuration

**Razorpay Dashboard → Subscriptions → Plans → Create Plan**

| Field | Value |
|-------|-------|
| Plan Name | `Watch Hub Sync Premium` |
| Billing Amount | ₹99/month (or your pricing) |
| Billing Frequency | Monthly |
| Currency | INR |
| UPI Autopay | Enabled |

Note the Plan ID (e.g., `plan_...`) → set as `RAZORPAY_PLAN_ID_PREMIUM`.

### 5.2 Webhook Configuration

**Razorpay Dashboard → Settings → Webhooks → Add New Webhook**

```
URL: https://watchhubsync.com/api/webhooks/razorpay
```

Enable these events:
- `subscription.charged` ← primary confirmation event
- `subscription.halted`
- `subscription.cancelled`
- `subscription.completed`
- `payment.failed`

Set a **Secret** (32+ random chars) → set as `RAZORPAY_WEBHOOK_SECRET`.

### 5.3 Notes Convention

When creating a Razorpay subscription via your billing API, always set:

```typescript
notes: {
  whs_user_id:  userId,   // Supabase user UUID
  whs_email:    email,    // For Razorpay dashboard search
}
```

This is how `src/app/api/webhooks/razorpay/route.ts` resolves the user without a reverse-lookup table.

---

## 6. Axiom Observability Setup

### 6.1 Dataset Configuration

1. [Axiom](https://axiom.co) → New Dataset → Name: `watchhubsync-production`
2. Create API Token → Scope: `Ingest` on the `watchhubsync-production` dataset
3. Token format: `xaat-...` → set as `AXIOM_TOKEN`

### 6.2 Recommended Axiom Dashboards

Create these saved queries after the first day of production traffic:

**LiveKit Webhook Health:**
```
['watchhubsync-production']
| where service == "api.webhooks.livekit"
| summarize count() by bin_auto(_time), status
```

**Token Provisioning Latency (p95):**
```
['watchhubsync-production']
| where service == "api.room.token"
| summarize percentiles(duration_ms, 50, 95, 99) by bin(5m, _time)
```

**Billing Meter Processing Rate:**
```
['watchhubsync-production']
| where service == "api.webhooks.livekit"
| where status == "ok"
| summarize sum(todouble(participant_minutes)) by bin(1h, _time)
```

**Failed Webhook Rate Alert:**
```
['watchhubsync-production']
| where service startswith "api.webhooks"
| where status == "error"
| summarize count() by bin(5m, _time)
| where count_ > 5
```
Set this as a monitor with PagerDuty or Slack notification.

---

## 7. Pre-Launch Verification Checklist

Run through these checks in staging before flipping DNS to production.

### Functional Checks

- [ ] Create a room via dashboard → QR code generates → companion scan works
- [ ] Join room on second device → LiveKit `participant_joined` webhook fires
- [ ] Press pause on YouTube → `pause` event emitted → second device pauses within 1s
- [ ] Leave room → LiveKit `participant_left` webhook fires → `billing_meters` row created
- [ ] Verify `billing_meters.is_anomalous = false` for normal sessions
- [ ] End room → LiveKit `room_finished` fires → room status updates to `closed`

### Billing Checks

- [ ] Stripe test mode: create subscription → `customer.subscription.created` fires → user tier = `premium`
- [ ] Razorpay test mode: `subscription.charged` fires → user tier confirmed `premium`
- [ ] Simulate 120+ minutes for free-tier user → `chargeable_minutes > 0` appears in billing_meters
- [ ] Verify `billing_meters.is_processed = true` after Stripe meter event push
- [ ] Attempt to mutate `billing_meters` directly with anon key → RLS blocks it

### Security Checks

- [ ] Attempt token fetch for a room you're not a participant of → `403 NOT_A_PARTICIPANT`
- [ ] Send a LiveKit webhook with wrong signature → `401` returned
- [ ] Send a Stripe webhook with wrong `stripe-signature` → `401` returned
- [ ] Send a Razorpay webhook with wrong `x-razorpay-signature` → `401` returned
- [ ] Verify no `Authorization` header values appear in Axiom logs
- [ ] Verify middleware rate limiting blocks > N requests/minute from same IP

### Performance Checks

- [ ] Lighthouse on `/login` → LCP < 2.5s on 4G throttle
- [ ] Lighthouse on `/dashboard` → LCP < 2.5s on 4G throttle
- [ ] Token API endpoint → p95 < 200ms (Axiom dashboard query)
- [ ] LiveKit webhook → p95 < 500ms (includes DB write)

---

## 8. Rollback Procedure

If a bad deploy reaches production:

1. **Immediate:** Vercel Dashboard → Deployments → previous deployment → **Promote to Production**
   - Takes effect in < 30 seconds globally
   - No DNS change required

2. **Database:** If the bad deploy wrote corrupt data to `billing_meters`:
   - Supabase Dashboard → Database → Restore → select PITR timestamp before the deploy
   - This restores the entire database — coordinate with active users

3. **Billing:** If meter events were incorrectly pushed to Stripe:
   - Stripe Dashboard → Billing → Meter Event Adjustments → create credit adjustments
   - Reference the `billing_meters.livekit_event_id` in the adjustment memo

---

*Last updated: Phase 6 completion. Next review: before go-live.*
