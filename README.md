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

Copy `.env.example` to `.env` and set these.

## Supabase schema

Single migration: `001_businesses_and_conversations.sql`.

- **businesses:** id, business_name, sender_name, owner_phone, leadlasso_number (unique), auto_reply_template, setup_type (forwarding | replace_number), plan_status (active | inactive), created_at, updated_at.
- **conversations:** id, business_id, customer_phone, owner_phone, leadlasso_number, status (active | closed), last_message_at, created_at, updated_at; unique(business_id, customer_phone).

Run the migration in the Supabase SQL Editor (or via CLI).

## Webhook endpoint skeletons

- **POST /webhooks/incoming-call** — Identify business by To; if none or inactive, Reject. Skeleton: always Reject; later branch on setup_type (replace_number vs forwarding).
- **POST /webhooks/incoming-call/dial-action** — Called when Dial to owner ends. Skeleton: Hangup. Later: send auto-reply SMS on no-answer.
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
