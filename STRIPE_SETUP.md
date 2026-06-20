# Watch Hub Sync — Stripe UK Setup Guide (Letora Ltd)

This document is the authoritative step-by-step configuration guide for the Stripe UK entity powering Watch Hub Sync. All values shown as `pk_live_...`, `sk_live_...`, `price_...`, etc. are placeholders. Replace them with real values from your Stripe Dashboard and record them in Vercel's environment variable panel — never in source code or committed files.

---

## 0. Pre-Requisites

| Requirement | Status |
|-------------|--------|
| Letora Ltd company registered (Companies House) | Must be complete before Stripe activation |
| Stripe account created at stripe.com with UK business details | Must use a UK address and UK bank account |
| Monzo Business account open and bank details available | Required for payout bank linkage in §3 |
| Vercel project deployed (see INFRASTRUCTURE.md) | Required before webhook registration |

---

## 1. Stripe Account Configuration (UK Entity)

### 1.1 Business Details

When prompted during Stripe onboarding, enter:

| Field | Value |
|-------|-------|
| Business name | Letora Ltd |
| Business type | Limited company |
| Country | United Kingdom |
| Registration number | *(your Companies House number)* |
| Business category | Software / SaaS |
| Website | https://watchhubsync.online |
| Statement descriptor | WATCHHUBSYNC |
| Short descriptor | WHS |

The **statement descriptor** is what appears on customer bank statements. Keep it recognisable to avoid chargebacks from confused subscribers.

### 1.2 Stripe Dashboard Settings

After onboarding:

1. **Settings → Business details** — Confirm legal entity name matches Companies House exactly
2. **Settings → Public details** → Support email: *(your support email)* → Support phone: *(your support number)*
3. **Settings → Branding** → Upload the Watch Hub Sync logo, set brand colour `#0A0A0A`
4. **Settings → Customer emails** → Enable: Payment receipts, Failed payment notifications, Subscription renewal reminders

---

## 2. API Keys

### 2.1 Key Locations

Stripe Dashboard → **Developers** → **API keys**:

| Key | Placeholder | Use |
|-----|-------------|-----|
| Publishable key (live) | `pk_live_YOUR_PUBLISHABLE_KEY` | Frontend (if building a payment UI) |
| Secret key (live) | `sk_live_YOUR_SECRET_KEY` | Server only — set in Vercel as `STRIPE_SECRET_KEY` |
| Publishable key (test) | `pk_test_YOUR_TEST_PUBLISHABLE_KEY` | Local development |
| Secret key (test) | `sk_test_YOUR_TEST_SECRET_KEY` | Local development — set in `.env.local` |

### 2.2 Set in Vercel

Vercel Dashboard → Project → Settings → Environment Variables:

```
STRIPE_SECRET_KEY = sk_live_YOUR_SECRET_KEY        (Production scope only)
STRIPE_SECRET_KEY = sk_test_YOUR_TEST_SECRET_KEY   (Preview scope only)
```

The Zod validator in `src/lib/env.ts` enforces the `sk_(live|test)_` prefix — it will reject the key at build time if the format is wrong.

### 2.3 Restricted Keys (Recommended for Webhook Handler)

For the webhook handler (`/api/webhooks/stripe`), create a **Restricted Key** instead of using the full secret key:

Stripe Dashboard → Developers → API keys → **Create restricted key**:

| Resource | Permission |
|----------|------------|
| Customers | Read |
| Subscriptions | Read |
| Invoices | Read |
| Billing meters | Write |
| Billing meter events | Write |

Name it: `WHS Webhook Handler — Production`

This limits blast radius if the key is ever exposed — it cannot create charges or initiate payouts.

---

## 3. Payout Bank Account (Monzo Business)

### 3.1 Link Your Monzo Business Account

Stripe Dashboard → **Settings** → **Payouts** → **Add bank account**:

You will need from your Monzo Business account:

| Field | Where to find it |
|-------|-----------------|
| Account number (8 digits) | Monzo app → Account → Account details |
| Sort code (6 digits, format XX-XX-XX) | Monzo app → Account → Account details |
| Account holder name | Must match exactly: `Letora Ltd` |
| Currency | GBP |

> **Important:** Enter these directly into Stripe's dashboard. Never write sort code or account number in any file, code, or documentation committed to Git.

### 3.2 Payout Schedule

Stripe Dashboard → Settings → Payouts → **Payout schedule**:

| Setting | Recommended value |
|---------|-------------------|
| Payout frequency | Weekly (every Monday) |
| Minimum payout amount | £1.00 |
| Currency | GBP |

Weekly payouts balance cash-flow visibility against the overhead of frequent settlement. Adjust to daily once monthly revenue exceeds £5,000.

### 3.3 Verify Bank Account

Stripe will make two micro-deposits (< £0.10 each) to your Monzo account within 1–2 business days. Verify them in the Stripe dashboard to activate payouts.

---

## 4. Products and Pricing

### 4.1 Create the Premium Subscription Product

Stripe Dashboard → **Product catalogue** → **Add product**:

| Field | Value |
|-------|-------|
| Name | Watch Hub Sync Premium |
| Description | Unlimited synchronized watch sessions with priority sync |
| Statement descriptor | WHS PREMIUM |
| Tax code | `txcd_10103001` (SaaS / electronically supplied services) |

### 4.2 Create the Usage-Based Price (GBP)

On the product page, click **Add price**:

| Field | Value |
|-------|-------|
| Pricing model | Usage-based |
| Meter | participant_minutes *(see §5 — create meter first)* |
| Per unit price | £0.007 per participant-minute (adjust to your strategy) |
| Currency | GBP |
| Billing period | Monthly |
| Aggregate usage | Sum |

After saving, note the **Price ID**:
```
price_YOUR_PRICE_ID_GBP
```

Set in Vercel:
```
STRIPE_PRICE_ID_PREMIUM = price_YOUR_PRICE_ID_GBP
```

### 4.3 Free Tier Entitlement (Credit Grant)

The application enforces the free tier (120 minutes/month) at the application layer via `meter-calculator.ts`. No Stripe-side free trial or coupon is needed — only `chargeable_minutes` (minutes beyond the free cap) are ever pushed to Stripe's Meter Events API.

If you later want Stripe to display the free allowance on invoices, create a **Credit Grant** of 120 units on the `participant_minutes` meter for all new subscribers.

---

## 5. Usage Billing Meter Configuration

### 5.1 Create the Participant Minutes Meter

Stripe Dashboard → **Billing** → **Meters** → **Create meter**:

| Field | Value |
|-------|-------|
| Name | Participant Minutes |
| Event name | `participant_minutes` |
| Default aggregation | `sum` |
| Value settings — Value field | `value` |
| Customer mapping — Field | `stripe_customer_id` |
| Customer mapping — Type | `by_id` |

After creating the meter, note the **Meter ID**:
```
mtrd_YOUR_METER_ID
```

Set in Vercel:
```
STRIPE_METER_ID_PARTICIPANT_MINUTES = mtrd_YOUR_METER_ID
```

### 5.2 Meter Event Payload Schema

Our server (`src/app/api/webhooks/livekit/route.ts`) pushes meter events via `pushStripeParticipantMinutes()` in `src/lib/billing/stripe-client.ts`. The exact payload shape it sends:

```json
{
  "event_name": "participant_minutes",
  "payload": {
    "stripe_customer_id": "cus_CUSTOMER_ID",
    "value": "42"
  },
  "identifier": "lk_evt_LIVEKIT_EVENT_ID",
  "timestamp": 1718870400
}
```

Field mapping from `meter-calculator.ts` output:

| `meter-calculator.ts` field | Stripe Meter Event field | Notes |
|-----------------------------|--------------------------|-------|
| `billableMinutes` | `payload.value` | String-cast integer; ceiling division, min 1 |
| `stripeCustomerId` | `payload.stripe_customer_id` | Looked up from `users` table |
| `livekitEventId` | `identifier` | Idempotency key — prevents double-billing |
| `periodStart` (Unix epoch) | `timestamp` | UTC; marks when session occurred |

The `identifier` field is critical: Stripe deduplicates meter events by this value within a 24-hour window. Our `billing_meters.livekit_event_id` (the `UNIQUE` column) plus Stripe's deduplication gives us two independent idempotency guarantees.

### 5.3 Test a Meter Event

Using the Stripe CLI (install from https://stripe.com/docs/stripe-cli):

```bash
# Switch to test mode key
stripe login

# Push a test meter event
stripe billing meter-events create \
  --event-name="participant_minutes" \
  --payload[stripe_customer_id]="cus_TEST_CUSTOMER_ID" \
  --payload[value]="30" \
  --identifier="test_event_$(date +%s)"
```

Verify it appears in: Stripe Dashboard → Billing → Meters → `participant_minutes` → **Events**

---

## 6. Webhook Configuration

### 6.1 Register the Webhook Endpoint

Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**:

```
Endpoint URL: https://watchhubsync.online/api/webhooks/stripe
```

### 6.2 Events to Subscribe

Enable exactly these events (disable all others to reduce noise and processing load):

| Event | Trigger | Handler in route.ts |
|-------|---------|---------------------|
| `customer.subscription.created` | New subscriber | Sets user tier to `premium` |
| `customer.subscription.updated` | Plan change | Updates tier |
| `customer.subscription.deleted` | Cancellation | Downgrades user to `free` |
| `invoice.payment_succeeded` | Monthly payment cleared | Marks billing meters `is_processed = true` |
| `invoice.payment_failed` | Payment declined | Logs; no immediate downgrade |
| `billing.meter_event_summary.updated` | Meter aggregation ready | (Future: invoice preview) |

### 6.3 Retrieve the Signing Secret

After creating the endpoint, click **Reveal** under **Signing secret**:

```
whsec_YOUR_WEBHOOK_SIGNING_SECRET
```

Set in Vercel:
```
STRIPE_WEBHOOK_SECRET = whsec_YOUR_WEBHOOK_SIGNING_SECRET
```

The Zod validator enforces the `whsec_` prefix. The `constructStripeEvent()` function in `src/lib/billing/stripe-client.ts` uses this to verify every inbound webhook before parsing the payload.

### 6.4 Test Webhook Delivery

```bash
# Forward live Stripe events to your local dev server
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# In another terminal, trigger a test event
stripe trigger customer.subscription.created
stripe trigger invoice.payment_succeeded
```

Confirm in your terminal that the webhook handler returns `200` for each event.

---

## 7. Tax Configuration (UK VAT)

### 7.1 Register for UK VAT (When Required)

UK VAT registration is required once annual taxable turnover exceeds £90,000 (2024/25 threshold). Until then, you do not need to charge VAT.

When registered:

Stripe Dashboard → Settings → **Tax** → Enable **Stripe Tax**

| Setting | Value |
|---------|-------|
| Home country | United Kingdom |
| Default tax behavior | Exclusive (price + VAT added on top) |
| Tax ID collection | Optional at checkout |

Stripe Tax automatically calculates UK VAT (20% standard rate for digital services) and EU VAT (OSS scheme) on subscriptions.

### 7.2 Invoice Footer (Legal Requirement)

Stripe Dashboard → Settings → **Invoice template**:

Add to footer:
```
Letora Ltd | Registered in England and Wales | Company No: YOUR_COMPANIES_HOUSE_NUMBER
VAT Registration No: GB YOUR_VAT_NUMBER (if registered)
Registered address: YOUR_REGISTERED_ADDRESS
```

---

## 8. Customer Portal Configuration

Stripe Dashboard → Settings → **Billing** → **Customer portal**:

Enable:
- [ ] Customers can cancel subscriptions
- [ ] Customers can update payment methods
- [ ] Show invoice history (last 12 months)
- [ ] Allow customers to switch between plans (if you add tiers later)

**Portal link** (save this for your account settings page):
```
https://billing.stripe.com/p/login/YOUR_PORTAL_ID
```

---

## 9. Environment Variables Summary

Complete reference of all Stripe-related env vars. Set in Vercel Dashboard only — never in committed files.

| Variable | Format | Scope | Description |
|----------|--------|-------|-------------|
| `STRIPE_SECRET_KEY` | `sk_live_...` | Production | Full secret key or restricted key |
| `STRIPE_SECRET_KEY` | `sk_test_...` | Preview/Dev | Test mode key |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Production + Preview | Webhook signing secret |
| `STRIPE_PRICE_ID_PREMIUM` | `price_...` | Production + Preview | GBP usage-based price |
| `STRIPE_METER_ID_PARTICIPANT_MINUTES` | `mtrd_...` | Production + Preview | Participant minutes meter ID |

---

## 10. Pre-Launch Billing Checklist

- [ ] Stripe account verified (identity documents submitted and approved)
- [ ] Monzo Business bank account linked and micro-deposits verified
- [ ] `participant_minutes` meter created; meter ID set in Vercel
- [ ] GBP usage-based price created and linked to meter; price ID set in Vercel
- [ ] Webhook endpoint registered; signing secret set in Vercel
- [ ] Stripe CLI test: `stripe trigger invoice.payment_succeeded` returns 200
- [ ] Test subscription created; `billing_meters` row marked `is_processed = true` after `invoice.payment_succeeded`
- [ ] Customer portal URL saved for account settings page
- [ ] Invoice footer contains legal company details
- [ ] Stripe Tax enabled (or noted as deferred until VAT threshold reached)

---

*This document contains no real credentials. All `pk_live_`, `sk_live_`, `price_`, `mtrd_`, `whsec_`, and `cus_` values are placeholders to be replaced manually in Stripe Dashboard and Vercel. Never commit real values to this file.*
