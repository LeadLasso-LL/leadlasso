# Juvo Backend

Node.js + Express + Supabase. One backend, one set of webhooks, many businesses. Business is identified by the Juvo phone number (`juvo_number`) that received the call. AI voice receptionist product — leads are captured from calls (Retell AI), not SMS threads.

## Project structure

```
src/
  index.ts              # Express app, portal, onboarding, webhooks
  lib/
    supabase.ts         # Supabase client and row types
    twilio.ts           # Twilio client and webhook base URL
  services/
    business.ts         # findBusinessByJuvoNumber(), isBusinessActive()
    leads.ts            # ensureCallLead() — voice lead capture
    email.ts            # Welcome + password reset (Resend)
  webhooks/
    incoming-call.ts    # Twilio voice URL + status callback → lead rows
    stripe.ts           # Checkout completed → provision number + business
supabase/migrations/
  013_juvo_schema_rebuild.sql   # Apply after prior migrations
templates/
  portal.html           # Customer admin portal
public/
  onboarding.html       # Stripe checkout onboarding form
  index.html            # Marketing landing page
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default 3000) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio API |
| `TWILIO_WEBHOOK_BASE_URL` | Public base URL for TwiML callbacks |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Backend DB |
| `SUPABASE_ANON_KEY` | Injected into `/portal` for browser Auth + RLS |
| `PORTAL_PUBLIC_ORIGIN` | e.g. `https://start.getjuvo.io` |
| `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET` | Billing |
| `RESEND_API_KEY` / `FROM_EMAIL` | Transactional email |

Copy `.env.example` to `.env` and set values.

## Supabase schema (after migration 013)

- **businesses:** `juvo_number` (unique), `retell_agent_id`, `industry`, plus existing billing/portal fields. Removed: `sender_name`, `auto_reply_template`.
- **leads:** `caller_name`, `caller_number`, `job_description`, `call_id`, `recording_url`, `transcript`, `status`, timestamps.
- **Dropped:** `conversations`, `conversation_messages`, `outbound_customer_sms`.

Run migrations through `013_juvo_schema_rebuild.sql` in order.

## Webhooks

- **POST /webhooks/incoming-call** — TwiML Dial (replace_number) or Reject (forwarding).
- **POST /webhooks/incoming-call/status** — Missed-call detection; creates `leads` rows (no SMS).
- **POST /webhooks/stripe** — Provisions Twilio number and creates business after checkout.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Create a business via onboarding or `npx ts-node scripts/create-business.ts`, set `juvo_number` to the Twilio number, point Twilio voice webhooks to `/webhooks/incoming-call` and status callback to `/webhooks/incoming-call/status`.
