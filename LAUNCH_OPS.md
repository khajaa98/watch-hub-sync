# Watch Hub Sync — Production Cutover & Launch Operations

**Domain:** `watchhubsync.online`
**Registrar (origin):** GoDaddy
**DNS/CDN layer:** Cloudflare
**Application host:** Vercel
**Analytics:** PostHog

Read this document in full before touching any live system. Every step is ordered. Skipping steps or reordering them causes SSL mismatches, 404 routing blackholes, or billing pipeline interruptions.

---

## 0. Prerequisites Checklist

Complete these before beginning. Do NOT proceed until every item has a ✓.

- [ ] `setup-git.sh` has been run — repository is on GitHub
- [ ] Vercel project is connected to the GitHub repo (import complete, env vars set)
- [ ] At least one successful Vercel production deployment exists with a working `.vercel.app` URL
- [ ] Supabase production project has PITR enabled (see INFRASTRUCTURE.md §1.2)
- [ ] All production env vars are set in Vercel Dashboard (see INFRASTRUCTURE.md §2.3)
- [ ] PostHog project is created and Project API Key (phc_...) is set in Vercel as `NEXT_PUBLIC_POSTHOG_KEY`
- [ ] LiveKit webhook is configured pointing to the `.vercel.app` URL (temporarily) for pre-launch testing
- [ ] Stripe and Razorpay webhooks are configured pointing to the `.vercel.app` URL (temporarily)
- [ ] You have access to GoDaddy → Domain Manager for `watchhubsync.online`
- [ ] You have created a Cloudflare account at https://cloudflare.com

---

## 1. Vercel Project Setup

### 1.1 Import the Repository

1. Go to https://vercel.com/new
2. Click **Import Git Repository** → select `watchhubsync` from your GitHub account
3. **Framework Preset:** Next.js (auto-detected)
4. **Root Directory:** `cineroom/` — CRITICAL: the Next.js app is inside the subdirectory
5. **Build Command:** `pnpm next build` (auto-detected from package.json)
6. **Output Directory:** `.next` (auto-detected)
7. **Install Command:** `pnpm install --frozen-lockfile`
8. Click **Deploy**

### 1.2 Confirm Deployment Health

After the first deploy:

```
https://[your-project].vercel.app/
```

Expected: redirects to `/dashboard` → login page renders → no console errors.

If the build fails:
- Check the build logs for Zod validation errors (missing env vars)
- See INFRASTRUCTURE.md §2.3 for the complete env var list

### 1.3 Note Your Vercel-Assigned URL

It will look like:
```
watchhubsync-[hash].vercel.app
```

You'll use this URL for webhook configuration in Phase 2 (temporary), and Vercel will continue to serve it even after the custom domain is live — useful for health checks.

### 1.4 Set PostHog Environment Variables

In Vercel Dashboard → Project → Settings → Environment Variables, add:

| Variable | Value | Scope |
|----------|-------|-------|
| `NEXT_PUBLIC_POSTHOG_KEY` | `phc_YOUR_KEY` | Production + Preview |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://app.posthog.com` | Production + Preview |

Redeploy after adding these (Vercel does not automatically rebuild after env var changes).

---

## 2. PostHog Project Setup

### 2.1 Create the Project

1. Go to https://app.posthog.com → **New Project**
2. **Project Name:** `Watch Hub Sync Production`
3. **Region:** US (or EU if you prefer EU data residency)
4. Note the **Project API Key** — it starts with `phc_`

### 2.2 Configure Session Recordings

PostHog Dashboard → **Settings** → **Session Recordings**:

- Enable session recording: **ON**
- **Capture network requests:** OFF (we do not want API request payloads captured)
- **Mask all inputs:** ON (already set in our `posthog-provider.tsx`)
- **Minimum session duration:** 10 seconds (filter out accidental page loads)

### 2.3 Create Event Definitions

PostHog Dashboard → **Data Management** → **Events** → **New Event Definition**:

Define these events so they appear in the dashboard immediately:

| Event Name | Description |
|------------|-------------|
| `room_creation_start` | User opened CreateRoomDialog |
| `platform_selected` | User selected OTT platform in step 1 |
| `step_advanced` | User moved from step N to N+1 |
| `room_created` | Room successfully created |
| `room_creation_failed` | Room creation failed |
| `qr_copied` | User copied the magic invite link |
| `passkey_attempted` | User clicked Sign in with Passkey |
| `passkey_succeeded` | Passkey authentication succeeded |

### 2.4 Create Room Creation Funnel

PostHog Dashboard → **Insights** → **New Insight** → **Funnel**:

Steps:
1. `room_creation_start`
2. `platform_selected`
3. `room_created`

This is your core conversion funnel. Aim for > 70% completion rate.

---

## 3. Cloudflare Account and Site Setup

### 3.1 Create Cloudflare Account

Go to https://cloudflare.com → **Sign Up** (free plan is sufficient).

### 3.2 Add the Domain to Cloudflare

1. Cloudflare Dashboard → **Add a Site**
2. Enter: `watchhubsync.online`
3. Select plan: **Free** (adequate for our DDoS protection needs)
4. Click **Continue**

### 3.3 Cloudflare DNS Scan

Cloudflare will scan your current GoDaddy DNS records. You will see the existing records listed.

**What to do with them:**
- Keep any existing MX records (email) — do NOT delete
- You will REPLACE the A/CNAME records pointing to GoDaddy parking pages with Vercel records (see §4)
- Delete any GoDaddy-default parking A records (e.g., those pointing to GoDaddy's IPs)

### 3.4 Note Your Cloudflare Nameservers

After the DNS scan, Cloudflare shows you two nameservers like:
```
aria.ns.cloudflare.com
brad.ns.cloudflare.com
```

These are **unique to your account** — do not use nameservers from any documentation or example, use the ones Cloudflare shows you on screen.

**Copy both nameservers** before proceeding to the next step.

---

## 4. Cloudflare DNS Records for Vercel

Configure these records BEFORE changing the GoDaddy nameservers. This way the records are ready the moment DNS resolves to Cloudflare.

### 4.1 Add Apex Domain Record (watchhubsync.online)

Cloudflare Dashboard → `watchhubsync.online` → **DNS** → **Add Record**:

| Type | Name | Content | Proxy Status | TTL |
|------|------|---------|--------------|-----|
| `A` | `@` (or `watchhubsync.online`) | `76.76.21.21` | **Proxied (orange cloud ☁)** | Auto |

`76.76.21.21` is Vercel's Anycast IP for apex domains. Do NOT use Cloudflare's root-level CNAME flattening for Vercel — the A record approach is more reliable.

> **Why orange cloud (proxied)?** Traffic goes User → Cloudflare Edge → Vercel. Cloudflare terminates DDoS, caches static assets, and hides Vercel's real IP. This is what gives us CDN + DDoS protection.

### 4.2 Add WWW Subdomain Record

| Type | Name | Content | Proxy Status | TTL |
|------|------|---------|--------------|-----|
| `CNAME` | `www` | `cname.vercel-dns.com` | **Proxied (orange cloud ☁)** | Auto |

### 4.3 Add Vercel Custom Domain (Before DNS Switch)

Before the nameserver change takes effect, pre-register the custom domain in Vercel:

1. Vercel Dashboard → Project → **Settings** → **Domains**
2. Click **Add Domain**
3. Enter: `watchhubsync.online`
4. Also add: `www.watchhubsync.online`
5. Vercel will show "Invalid Configuration" until your DNS records propagate — this is normal

**Vercel will now request an SSL certificate** from Let's Encrypt / ZeroSSL for your domain. This happens automatically but requires DNS to be pointing at Vercel first. The cert is issued within minutes of DNS propagation.

---

## 5. GoDaddy Nameserver Change

> **Point of no return.** Once nameservers are changed, GoDaddy has no more control over your domain's DNS. DNS propagation is irreversible in the short term.
>
> **Best time to do this:** Low-traffic window (Tuesday–Thursday, 3–7am IST).

### 5.1 Access GoDaddy Domain Manager

1. Log in to https://godaddy.com
2. Go to **My Products** → **Domains** → `watchhubsync.online` → **Manage**
3. Click **DNS** tab

### 5.2 Change Nameservers

1. Scroll to **Nameservers** section
2. Click **Change** → **Enter my own nameservers**
3. Replace GoDaddy's default nameservers with your Cloudflare nameservers:
   - Nameserver 1: `aria.ns.cloudflare.com` ← use YOUR actual Cloudflare nameservers
   - Nameserver 2: `brad.ns.cloudflare.com` ← use YOUR actual Cloudflare nameservers
4. Click **Save**
5. Confirm the change (GoDaddy may show a warning — proceed)

### 5.3 Propagation Timeline

| Time After Change | Status |
|-------------------|--------|
| 0–5 minutes | GoDaddy shows new nameservers in their system |
| 5–30 minutes | ~30% of global resolvers see new NS |
| 30 minutes–4 hours | ~80% of resolvers updated (Indian ISPs vary) |
| 4–24 hours | ~99% of resolvers updated |
| 24–48 hours | Full global propagation guaranteed |

**Verify propagation** at: https://dnschecker.org/#NS/watchhubsync.online

You are looking for rows showing your Cloudflare nameservers everywhere, not GoDaddy's.

---

## 6. Cloudflare SSL/TLS Configuration

> This is the most critical configuration step. Getting SSL mode wrong causes redirect loops or insecure connections.

### 6.1 Set SSL Mode to Full (Strict)

Cloudflare Dashboard → `watchhubsync.online` → **SSL/TLS** → **Overview**:

Set mode to: **Full (strict)**

| Mode | Effect | Use? |
|------|--------|------|
| Off | HTTP only | NEVER |
| Flexible | Cloudflare uses HTTPS client-side, HTTP to Vercel | NEVER (causes issues) |
| Full | HTTPS on both sides, Vercel cert not validated | Not recommended |
| **Full (strict)** | HTTPS on both sides, Vercel cert validated | ✅ **USE THIS** |

**Why Full (strict)?** Vercel automatically provisions a valid TLS certificate for your domain from Let's Encrypt. Full (strict) mode verifies this certificate, giving you end-to-end encryption. "Flexible" mode would allow Cloudflare→Vercel to be HTTP, creating a security gap.

### 6.2 Enable Always Use HTTPS

Cloudflare Dashboard → **SSL/TLS** → **Edge Certificates**:

- **Always Use HTTPS:** ON — redirects all HTTP requests to HTTPS at Cloudflare's edge
- **HTTP Strict Transport Security (HSTS):** Enable with max-age of 6 months (26,280,000 seconds)
  - Enable Subdomain coverage: YES
  - Enable Preload: YES (after verifying everything works for 1 week first)

### 6.3 Minimum TLS Version

SSL/TLS → Edge Certificates → **Minimum TLS Version:** TLS 1.2

(TLS 1.3 is preferred but TLS 1.2 is required for older Android devices common in India — WebView on Android 5.0+ only supports TLS 1.2 at minimum.)

---

## 7. Cloudflare Security Configuration

### 7.1 DDoS Protection

This is automatic with the orange cloud (proxied) mode — no additional configuration required. Cloudflare's Autonomous DDoS Protection runs on all proxied traffic.

**Verify:** Cloudflare Dashboard → **Security** → **Overview** should show "DDoS: Enabled".

### 7.2 Bot Fight Mode

Cloudflare Dashboard → **Security** → **Bots**:

- **Bot Fight Mode:** ON (free tier)
- This blocks known bot traffic from reaching Vercel, reducing unnecessary serverless function invocations

**Exception:** Vercel's deployment status bot (`vercel-bot`) is automatically whitelisted — no action needed.

### 7.3 Security Level

Cloudflare Dashboard → **Security** → **Settings**:

- **Security Level:** Medium
  - "High" blocks too many Indian ISP IPs (BSNL, Airtel CGNAT ranges appear as suspicious to Cloudflare)
  - "Medium" is the right balance for an India-first product

### 7.4 Rate Limiting (Complement to App-Level Upstash Limiting)

Our application already implements rate limiting in Edge Middleware (Upstash Redis). Add a Cloudflare-level rate limit as a first line of defense:

Cloudflare Dashboard → **Security** → **WAF** → **Rate Limiting Rules** → **Create Rule**:

**Rule: API brute-force protection**

| Field | Value |
|-------|-------|
| Rule name | `WHS API Rate Limit` |
| When incoming requests match | URL path starts with `/api/auth` |
| Choose action | Block |
| Duration | 1 minute |
| Rate threshold | 20 requests per 1 minute per IP |

**Rule: Webhook integrity (do not rate-limit, but add firewall rule)**

Cloudflare Dashboard → **Security** → **WAF** → **Firewall Rules**:

Create a rule that blocks requests to `/api/webhooks/*` that do NOT have:
- A `stripe-signature` header (for Stripe)
- An `x-razorpay-signature` header (for Razorpay)
- An `Authorization` header (for LiveKit)

> Note: This is belt-and-suspenders — our webhook handlers already verify signatures at the application level. The Cloudflare rule blocks obviously fake webhook requests before they reach Vercel.

---

## 8. Cloudflare Cache Configuration

Vercel sets its own `Cache-Control` headers for static assets (immutable, 1 year). Cloudflare should respect these.

### 8.1 Cache Rules — Do Not Cache API Routes

Cloudflare Dashboard → **Caching** → **Cache Rules** → **Create Rule**:

**Rule: Bypass cache for API routes** (CRITICAL for billing integrity)

| Field | Value |
|-------|-------|
| Rule name | `WHS API Cache Bypass` |
| When | Request URL path starts with `/api/` |
| Then | Cache Eligibility: Bypass Cache |

> **Why this is critical:** If Cloudflare caches `/api/webhooks/livekit` responses, duplicate LiveKit webhook events could receive a cached "200 OK" without the underlying code running. This would silently skip billing meter creation. This rule ensures every webhook hit reaches Vercel.

### 8.2 Cache Rules — Long TTL for Static Assets

| Field | Value |
|-------|-------|
| Rule name | `WHS Static Assets Cache` |
| When | Request URL path starts with `/_next/static/` |
| Then | Cache Everything, Edge TTL: 1 year |

The `immutable` suffix in Vercel's `Cache-Control` headers, combined with content hashes in filenames, makes this safe.

### 8.3 Disable Problematic Cloudflare Features

These Cloudflare features interfere with Next.js hydration:

Cloudflare Dashboard → **Speed** → **Optimization**:

- **Rocket Loader:** **OFF** — Rocket Loader defers JavaScript loading in a way that breaks React hydration order. Always disable for Next.js apps.
- **Minify HTML:** OFF — Next.js already optimises its HTML output
- **Auto Minify (JS/CSS):** OFF — Next.js bundles are already minified by webpack; double-minification can corrupt output

---

## 9. Add Custom Domain in Vercel

(Should have been started in §4.3 — confirm and finalize here.)

### 9.1 Verify Domain Status

After DNS propagation (test with `dig watchhubsync.online +short`):

Vercel Dashboard → Project → **Settings** → **Domains**:

You should see:
```
watchhubsync.online          ✓ Valid Configuration
www.watchhubsync.online      ✓ Valid Configuration
```

If it still shows "Invalid Configuration" after 2 hours:
- Confirm the Cloudflare A record points to `76.76.21.21`
- Confirm the proxy is orange cloud (proxied), not grey (DNS only)
- Confirm Cloudflare SSL mode is Full (strict), NOT Flexible

### 9.2 Set Primary Domain

Vercel Dashboard → Domains → click the three-dot menu next to `watchhubsync.online` → **Set as Primary Domain**

This ensures:
- Vercel issues the SSL certificate for the root domain
- All traffic is canonically directed to the primary domain
- `www.watchhubsync.online` auto-redirects to `watchhubsync.online`

---

## 10. Update Webhook URLs

After the custom domain is live and verified, update all webhook endpoints:

### 10.1 LiveKit

LiveKit Dashboard → Project → Settings → Webhooks:

Change endpoint URL from:
```
https://[project-hash].vercel.app/api/webhooks/livekit
```
To:
```
https://watchhubsync.online/api/webhooks/livekit
```

### 10.2 Stripe

Stripe Dashboard → Developers → Webhooks → click endpoint → **Update**:

Change URL to:
```
https://watchhubsync.online/api/webhooks/stripe
```

### 10.3 Razorpay

Razorpay Dashboard → Settings → Webhooks → click endpoint → **Edit**:

Change URL to:
```
https://watchhubsync.online/api/webhooks/razorpay
```

### 10.4 Supabase Auth (Svix)

If you are using Supabase Auth Hooks with Svix for user creation events:

Supabase Dashboard → Authentication → Hooks:

Change endpoint URL to:
```
https://watchhubsync.online/api/auth/webhook
```

---

## 11. Update App URL Environment Variable

After the domain is live, update the app URL in Vercel:

Vercel Dashboard → Project → Settings → Environment Variables:

| Variable | Old Value | New Value |
|----------|-----------|-----------|
| `NEXT_PUBLIC_APP_URL` | `https://[project].vercel.app` | `https://watchhubsync.online` |

**Trigger a redeploy after changing this.** The env var is embedded in the build and affects OG tag URLs, passkey RP origin, and OAuth redirect URLs.

---

## 12. End-to-End Verification Sequence

Run these checks in order after the domain is live.

### 12.1 DNS and SSL

```bash
# Verify A record resolves
dig watchhubsync.online +short
# Expected: 76.76.21.21  (or Cloudflare's anycast IPs — varies by region)

# Verify SSL certificate (should show watchhubsync.online, issued by Let's Encrypt)
curl -I https://watchhubsync.online

# Check for redirect loops (should be 200, not 301 chain)
curl -L -I https://watchhubsync.online/login
```

### 12.2 SSL Labs Full Report

Go to: https://www.ssllabs.com/ssltest/analyze.html?d=watchhubsync.online

Target grade: **A** or **A+**

If you see:
- **B**: Check that HSTS is enabled
- **C**: TLS 1.0/1.1 is enabled — disable in Cloudflare SSL settings
- **F**: Certificate issue — verify Cloudflare SSL mode is Full (strict)

### 12.3 Core Web Vitals Baseline

Run Lighthouse in Chrome DevTools (Incognito, 4G throttle):

Target scores:
| Metric | Target |
|--------|--------|
| LCP | < 2.5s |
| INP | < 200ms |
| CLS | < 0.1 |
| FCP | < 1.8s |
| TTFB | < 800ms |

PostHog confirmation: after visiting the live site, go to PostHog Dashboard → Activity → confirm `$pageview` events are appearing with `$current_url: https://watchhubsync.online/login`.

### 12.4 Billing Pipeline End-to-End Test

Using Stripe test mode and LiveKit test credentials:

1. Create a room on `watchhubsync.online/dashboard`
2. Join the room with a second device
3. Wait 2 minutes
4. Leave the room (trigger `participant_left`)
5. Check Supabase `billing_meters` table — a row should exist with:
   - `billable_minutes >= 1`
   - `is_processed = false`
   - `is_anomalous = false`
6. Check Axiom: `['watchhubsync-production'] | where service == "api.webhooks.livekit"`

### 12.5 Passkey Flow

1. Open `https://watchhubsync.online/login` in Chrome on Android
2. Enter your email → click "Continue"
3. Click "Sign in with Passkey" (appears if device supports WebAuthn)
4. Complete the biometric / PIN prompt
5. Confirm redirect to `/dashboard`

> This verifies that the passkey RP origin (`watchhubsync.online`) matches the new domain, not the `.vercel.app` URL.

---

## 13. Post-Launch Monitoring Setup

### 13.1 Cloudflare Analytics

Cloudflare Dashboard → `watchhubsync.online` → **Analytics**:

- Review the **Web Traffic** graph — should spike when you share the launch
- Check **Threats** — should show 0 for a fresh launch
- Bookmark the **Performance** tab for ongoing CDN cache hit rate monitoring

Target: > 60% cache hit rate for static assets within 24h of launch.

### 13.2 Axiom Alert for Webhook Failures

Axiom Dashboard → **Monitors** → **New Monitor**:

Query:
```
['watchhubsync-production']
| where service startswith "api.webhooks"
| where status == "error"
| summarize count() by bin(5m, _time)
| where count_ > 3
```

Alert: Slack or email when triggered.

> More than 3 webhook errors in 5 minutes means a billing event is being dropped. This is a P0 alert — wake someone up.

### 13.3 Vercel Deployment Notifications

Vercel Dashboard → Project → **Settings** → **Git** → **Deployment Notifications**:

- Notify on failed deployments: **YES**
- Channel: your Slack or email

---

## 14. Rollback Procedure

### 14.1 Application Rollback (< 60 seconds)

Vercel Dashboard → Project → **Deployments** → find the last known-good deployment → **Promote to Production**

This atomically swaps the serving deployment. DNS does not change. No user impact beyond a brief cold-start for the new (old) functions.

### 14.2 DNS Rollback (Emergency — rare)

If Cloudflare itself becomes unavailable (extremely rare), you can move nameservers back to GoDaddy:

1. GoDaddy → Domain Manager → `watchhubsync.online` → DNS → Nameservers → **Change**
2. Select **Use GoDaddy's default nameservers**
3. Reconfigure A record in GoDaddy DNS pointing to Vercel's IP

> Note: This takes 24–48 hours to propagate. This is a last-resort option only. Cloudflare has 99.99% uptime SLA on free plans. Do not do this unless Cloudflare confirms a datacenter incident affecting your zone.

### 14.3 Database Rollback

See INFRASTRUCTURE.md §8 — Rollback Procedure.

---

## 15. Go-Live Announcement Readiness

Before announcing to users:

- [ ] `https://watchhubsync.online` loads with < 2.5s LCP on 4G
- [ ] SSL grade is A or A+ on SSL Labs
- [ ] PostHog shows `$pageview` events from real traffic
- [ ] Axiom shows no webhook errors
- [ ] Billing pipeline test in §12.4 passed
- [ ] Stripe test webhook shows `invoice.payment_succeeded` correctly marks meters processed
- [ ] Passkey sign-in works on both iOS Safari and Android Chrome
- [ ] Room creation → QR code → companion join → sync event → room close works end-to-end

---

*Document version: Phase 7 — Production Cutover. Last updated: launch day.*
