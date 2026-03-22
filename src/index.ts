/**
 * LeadLasso backend — one Express app, one set of webhooks, many businesses.
 * Business is identified by the Twilio number (To) that received the call or SMS.
 * No per-business flows; no Twilio Studio as the main logic layer.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { handleIncomingCall, handleIncomingCallDialAction } from './webhooks/incoming-call';
import { handleIncomingSms } from './webhooks/sms';
import { handleOwnerReply } from './webhooks/owner-reply';
import { handleOnboardingBusiness, handleOnboardingSuccess } from './routes/onboarding';
import { handleStripeWebhook } from './webhooks/stripe';

const app = express();
const PORT = process.env.PORT || 3000;

/** Browser onboarding form on getleadlasso.io calls API on start.getleadlasso.io — CORS required. */
const CORS_ALLOWED_ORIGINS = new Set(
  [
    'https://getleadlasso.io',
    'https://www.getleadlasso.io',
    'https://start.getleadlasso.io',
    ...(process.env.CORS_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ]
);

app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Stripe webhook must get raw body for signature verification (register before body parsers)
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function getPortalTemplatePath(): string {
  const inDist = path.join(__dirname, 'templates', 'portal.html');
  if (fs.existsSync(inDist)) return inDist;
  return path.join(__dirname, '..', 'templates', 'portal.html');
}

app.get('/portal', (_req, res) => {
  try {
    let html = fs.readFileSync(getPortalTemplatePath(), 'utf8');
    html = html
      .replace('SUPABASE_URL_PLACEHOLDER', JSON.stringify(process.env.SUPABASE_URL))
      .replace('SUPABASE_ANON_KEY_PLACEHOLDER', JSON.stringify(process.env.SUPABASE_ANON_KEY));
    res.type('html').send(html);
  } catch {
    res.status(500).type('html').send('Portal is not available (template missing).');
  }
});

app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// --- Webhooks: same URLs for all LeadLasso numbers; backend resolves business by To (or From for owner-reply) ---

app.post('/webhooks/incoming-call', handleIncomingCall);
app.all('/webhooks/incoming-call/dial-action', handleIncomingCallDialAction);

app.post('/webhooks/incoming-sms', handleIncomingSms);

app.post('/webhooks/owner-reply', handleOwnerReply);

app.post('/onboarding/business', handleOnboardingBusiness);
app.get('/onboarding/success', handleOnboardingSuccess);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
