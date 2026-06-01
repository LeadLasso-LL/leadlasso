/**
 * Juvo backend — Express app for onboarding, portal auth helpers, and webhooks.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import {
  handleIncomingCall,
  handleIncomingCallDialAction,
  handleIncomingCallStatusCallback,
} from './webhooks/incoming-call';
import {
  handleOnboardingBusiness,
  handleOnboardingSubscribe,
  handleOnboardingSuccess,
} from './routes/onboarding';
import { handleStripeWebhook } from './webhooks/stripe';
import { handleRetellCallEnded } from './webhooks/retell-call-ended';
import { handleRetellCallStarted } from './webhooks/retell-call-started';
import { handlePatchLeadStatus } from './routes/leads';
import { handleSupportChat, handleSupportEscalate } from './routes/support';
import { supabase } from './lib/supabase';
import { passwordResetRedirectUrl, sendPasswordResetEmail } from './services/email';

const app = express();
const PORT = process.env.PORT || 3000;

const CORS_ALLOWED_ORIGINS = new Set(
  [
    'https://getjuvo.io',
    'https://www.getjuvo.io',
    'https://start.getjuvo.io',
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post(
  '/webhooks/retell-call-ended',
  express.raw({ type: 'application/json' }),
  handleRetellCallEnded
);
app.post(
  '/webhooks/retell-call-started',
  express.raw({ type: 'application/json' }),
  handleRetellCallStarted
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function getPortalTemplatePath(): string {
  const inDist = path.join(__dirname, 'templates', 'portal.html');
  if (fs.existsSync(inDist)) return inDist;
  return path.join(__dirname, '..', 'templates', 'portal.html');
}

function getSetPasswordTemplatePath(): string {
  const inDist = path.join(__dirname, 'templates', 'set-password.html');
  if (fs.existsSync(inDist)) return inDist;
  return path.join(__dirname, '..', 'templates', 'set-password.html');
}

function getDashboardTemplatePath(): string {
  const inDist = path.join(__dirname, 'templates', 'dashboard.html');
  if (fs.existsSync(inDist)) return inDist;
  return path.join(__dirname, '..', 'templates', 'dashboard.html');
}

function getOnboardingTemplatePath(): string {
  const inDist = path.join(__dirname, 'templates', 'onboarding.html');
  if (fs.existsSync(inDist)) return inDist;
  return path.join(__dirname, '..', 'templates', 'onboarding.html');
}

function injectSupabaseAuthPlaceholders(html: string): string {
  return html
    .replace('SUPABASE_URL_PLACEHOLDER', JSON.stringify(process.env.SUPABASE_URL))
    .replace('SUPABASE_ANON_KEY_PLACEHOLDER', JSON.stringify(process.env.SUPABASE_ANON_KEY));
}

function injectOnboardingPlaceholders(html: string): string {
  return injectSupabaseAuthPlaceholders(html).replace(
    'STRIPE_PUBLIC_KEY_PLACEHOLDER',
    JSON.stringify(process.env.STRIPE_PUBLIC_KEY?.trim() || '')
  );
}

app.get('/portal', (_req, res) => {
  try {
    const html = injectSupabaseAuthPlaceholders(fs.readFileSync(getPortalTemplatePath(), 'utf8'));
    res.type('html').send(html);
  } catch {
    res.status(500).type('html').send('Portal is not available (template missing).');
  }
});

app.get('/dashboard', (_req, res) => {
  try {
    const html = injectSupabaseAuthPlaceholders(fs.readFileSync(getDashboardTemplatePath(), 'utf8'));
    res.type('html').send(html);
  } catch {
    res.status(500).type('html').send('Dashboard is not available (template missing).');
  }
});

app.get('/auth/set-password', (_req, res) => {
  try {
    const html = injectSupabaseAuthPlaceholders(fs.readFileSync(getSetPasswordTemplatePath(), 'utf8'));
    res.type('html').send(html);
  } catch {
    res.status(500).type('html').send('Set password page is not available (template missing).');
  }
});

app.get('/onboarding', (_req, res) => {
  try {
    const html = injectOnboardingPlaceholders(fs.readFileSync(getOnboardingTemplatePath(), 'utf8'));
    res.type('html').send(html);
  } catch {
    res.status(500).type('html').send('Onboarding is not available (template missing).');
  }
});

function portalPublicOrigin(): string {
  const base = process.env.PORTAL_PUBLIC_ORIGIN || 'https://getjuvo.io';
  return base.replace(/\/$/, '');
}

app.post('/auth/request-password-reset', async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim();
    const redirectToFromClient = String(req.body?.redirectTo ?? '').trim();
    const redirectTo = (redirectToFromClient || passwordResetRedirectUrl()).trim();

    if (!email) {
      res.status(400).json({ success: false, error: 'Email is required.' });
      return;
    }

    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    });

    if (linkErr) {
      console.error('[auth reset] generateLink failed', linkErr);
      res
        .status(400)
        .json({ success: false, error: String(linkErr.message || 'Could not create reset link.') });
      return;
    }

    const actionLink = (linkData as { properties?: { action_link?: string } })?.properties?.action_link;
    if (!actionLink) {
      res.status(500).json({ success: false, error: 'Reset link generation failed.' });
      return;
    }

    await sendPasswordResetEmail({ email, actionLink });

    res.json({ success: true });
  } catch (err) {
    console.error('[auth reset] handler error', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Try again.' });
  }
});

app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhooks/incoming-call', handleIncomingCall);
app.post('/webhooks/incoming-call/status', handleIncomingCallStatusCallback);
app.all('/webhooks/incoming-call/dial-action', handleIncomingCallDialAction);

app.post('/onboarding/business', handleOnboardingBusiness);
app.get('/onboarding/success', handleOnboardingSuccess);
app.post('/api/onboarding/subscribe', handleOnboardingSubscribe);

app.patch('/api/leads/:id/status', handlePatchLeadStatus);
app.post('/api/support/escalate', handleSupportEscalate);
app.post('/api/support/chat', handleSupportChat);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
