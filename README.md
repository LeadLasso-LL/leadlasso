# LeadLasso Backend (scaffold)

Node.js + Express + Supabase. One backend, one set of webhooks, many businesses. Business is identified by the Twilio number (To) that received the call or SMS. No Twilio Studio; no per-business flows; no frontend or auth in this scaffold.

## Project structure

```
src/
  index.ts              # Express app, body parsers, webhook routes
  lib/
    supabase.ts         # Supabase client and row types (BusinessRow, ConversationRow)
    twilio.ts           # Twilio client and getWebhookBaseUrl()
  services/
    business.ts         # findBusinessByLeadlassoNumber(), isBusinessActive()
    conversation.ts     # findOrCreateConversation(), getMostRecentActiveConversationForBusiness/Owner()
    sms.ts              # sendSms() — Twilio send only
  webhooks/
    incoming-call.ts    # POST /webhooks/incoming-call + dial-action (skeletons)
    sms.ts             # POST /webhooks/incoming-sms (skeleton)
    owner-reply.ts     # POST /webhooks/owner-reply (skeleton)
supabase/migrations/
  001_businesses_and_conversations.sql
scripts/
  create-business.ts   # Insert one business (edit, then npx ts-node scripts/create-business.ts)
```

- **Webhooks:** Handle HTTP only; parse `To`/`From`/`Body`, call services, return TwiML or 200.
- **Services:** All business and conversation lookup/update and Twilio send; no HTTP.

## Package dependencies

- `express` — server and webhook routes
- `@supabase/supabase-js` — DB client
- `twilio` — voice/SMS
- `dotenv` — env loading
- TypeScript and types for Node/Express

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default 3000) |
| `TWILIO_ACCOUNT_SID` | Twilio API |
| `TWILIO_AUTH_TOKEN` | Twilio API |
| `TWILIO_WEBHOOK_BASE_URL` | Public base URL for TwiML action URLs (e.g. dial-action) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (backend only) |
| `SUPABASE_ANON_KEY` | Supabase anon (public) key — injected into `/portal` for browser Auth + RLS |
| `PORTAL_PUBLIC_ORIGIN` | Public origin for password-setup redirects (no trailing slash), e.g. `https://start.getleadlasso.io` |
| `RESEND_API_KEY` / `FROM_EMAIL` | Welcome email (includes set-password CTA for new auth users) |

Copy `.env.example` to `.env` and set these.

## Customer portal (`/portal`)

- Run migration `007_portal_auth_leads_rls.sql` (adds `businesses.user_id`, `leads`, RLS, `claim_business_for_current_user()`).
- In **Supabase → Authentication → URL configuration**, add **Redirect URLs**: `https://start.getleadlasso.io/portal` and `https://start.getleadlasso.io/auth/set-password` (match `PORTAL_PUBLIC_ORIGIN`).
- New customers get a **set-password** link in the Resend welcome email (server-generated Supabase recovery link). After setting a password, they sign in at `/portal` with **email + password**. `claim_business_for_current_user()` links the session to `businesses` when needed.
- Open **`GET /portal`** on your deployed API host (template is `templates/portal.html`, copied to `dist/templates` on build).

## Supabase schema

Single migration: `001_businesses_and_conversations.sql`.

- **businesses:** id, business_name, sender_name, owner_phone, leadlasso_number (unique), auto_reply_template, setup_type (forwarding | replace_number), plan_status (active | inactive), `owner_new_lead_alerts_enabled`, `owner_customer_reply_alerts_enabled` (portal: owner SMS prefs, default true), created_at, updated_at.
- **conversations:** id, business_id, customer_phone, owner_phone, leadlasso_number, status (active | closed), last_message_at, created_at, updated_at; unique(business_id, customer_phone).

Run the migration in the Supabase SQL Editor (or via CLI).

## Webhook endpoint skeletons

- **POST /webhooks/incoming-call** — Initial inbound voice: TwiML Dial (replace_number) or Reject (forwarding). Does **not** send missed-call SMS or create leads.
- **POST /webhooks/incoming-call/status** — Twilio voice **status callback** (final outcomes). Missed-call rules (duration, status, `AnsweredBy`), lead insert, and customer/owner SMS run here only. New numbers use this URL from provisioning; run migration `008_leads_call_followup_dedupe.sql` for idempotent `CallSid` dedupe. Existing Twilio numbers may still post terminal statuses to the voice URL (legacy); that path is still supported.
- **POST /webhooks/incoming-call/dial-action** — Dial action URL; returns empty TwiML.
- **POST /webhooks/incoming-sms** — Identify business by To; if From === owner, treat as owner reply (most recent conversation); else customer (find/create conversation, forward to owner). Skeleton: lookups only; no send yet.
- **POST /webhooks/owner-reply** — Identify owner by From; most recent active conversation; skeleton: update timestamps only; later: send to customer.

All endpoints use the same URLs for every LeadLasso number; the backend resolves the business by the number that received the event.

## Run

```bash
npm install
cp .env.example .env
# Set env vars, run Supabase migration
npm run dev
```

Create one business (e.g. via `npx ts-node scripts/create-business.ts`), set `leadlasso_number` in Supabase to that business’s Twilio number, then point Twilio voice and SMS webhooks to this server’s `/webhooks/incoming-call` and `/webhooks/incoming-sms`.
