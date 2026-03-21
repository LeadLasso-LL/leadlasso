/**
 * POST /onboarding/business
 * Accepts onboarding form data, creates a Stripe Checkout session for $79/month.
 * After payment, Stripe webhook (checkout.session.completed) provisions the number and creates the business.
 */
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase';
import type { SetupType } from '../lib/supabase';
import { normalizePhone } from '../lib/phone';
import { provisionLocalNumber, releaseNumber } from '../services/twilio-provisioning';

/** Where users land after Stripe Checkout (must match hosted onboarding page). Not PUBLIC_BASE_URL (webhooks/TwiML). */
const ONBOARDING_PAGE_ORIGIN = 'https://start.getleadlasso.io';

const REQUIRED = ['business_name', 'email', 'owner_phone', 'setup_type', 'preferred_area_code'] as const;

export type OnboardingBody = {
  business_name?: string;
  email?: string;
  sender_name?: string;
  owner_phone?: string;
  forward_to_phone?: string;
  setup_type?: string;
  auto_reply_template?: string | null;
  preferred_area_code?: string;
};

function toSetupType(value: string): SetupType {
  if (value === 'forward' || value === 'forwarding') return 'forwarding';
  if (value === 'replace_number') return 'replace_number';
  return 'replace_number';
}

export type CreateBusinessResult = { business_id: string; leadlasso_number: string };

/**
 * Normalizes onboarding data, provisions a Twilio number, inserts the business.
 * Used by the Stripe webhook after successful payment. Does not create Stripe sessions.
 */
export async function createBusinessWithNumber(
  data: OnboardingBody,
  stripeCustomerId: string | null,
  stripeCheckoutSessionId?: string | null
): Promise<CreateBusinessResult> {
  for (const key of REQUIRED) {
    const val = data[key];
    if (val === undefined || val === null || String(val).trim() === '') {
      throw new Error(`Missing or empty required field: ${key}`);
    }
  }

  const setup_type = toSetupType(String(data.setup_type).trim());
  if (setup_type === 'replace_number') {
    const ft = data.forward_to_phone;
    if (ft === undefined || ft === null || String(ft).trim() === '') {
      throw new Error('Missing or empty required field: forward_to_phone (required for Replace my number)');
    }
  }

  const business_name = String(data.business_name).trim();
  const email = String(data.email).trim();
  const sender_name = data.sender_name != null ? String(data.sender_name).trim() || null : null;
  const owner_phone = normalizePhone(String(data.owner_phone).trim());
  const forward_to_phone_raw = data.forward_to_phone != null ? String(data.forward_to_phone).trim() : '';
  const forward_to_phone = forward_to_phone_raw !== '' ? normalizePhone(forward_to_phone_raw) : null;
  const auto_reply_template = data.auto_reply_template != null ? String(data.auto_reply_template).trim() || null : null;
  const preferred_area_code = String(data.preferred_area_code).trim().replace(/\D/g, '').slice(0, 3);

  if (preferred_area_code.length !== 3) {
    throw new Error('preferred_area_code must be a valid 3-digit area code');
  }

  let provisioned: { phoneNumber: string; sid: string } | null = null;

  try {
    provisioned = await provisionLocalNumber(preferred_area_code);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'NO_NUMBERS_AVAILABLE') {
      throw new Error('NO_NUMBERS_AVAILABLE');
    }
    console.error('[onboarding] Twilio provision error', err);
    throw err;
  }

  const { data: business, error } = await supabase
    .from('businesses')
    .insert({
      email,
      business_name,
      sender_name,
      owner_phone,
      forward_to_phone,
      leadlasso_number: provisioned.phoneNumber,
      auto_reply_template,
      setup_type,
      plan_status: 'active',
      preferred_area_code,
      stripe_customer_id: stripeCustomerId,
      stripe_checkout_session_id: stripeCheckoutSessionId ?? null,
    })
    .select('id, leadlasso_number')
    .single();

  if (error) {
    console.error('[onboarding] DB insert error', error);
    try {
      await releaseNumber(provisioned.sid);
    } catch (releaseErr) {
      console.error('[onboarding] Failed to release number after DB error', releaseErr);
    }
    throw error;
  }

  return {
    business_id: business?.id ?? '',
    leadlasso_number: business?.leadlasso_number ?? provisioned.phoneNumber,
  };
}

export async function handleOnboardingBusiness(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as OnboardingBody;

    for (const key of REQUIRED) {
      const val = body[key];
      if (val === undefined || val === null || String(val).trim() === '') {
        res.status(400).json({ success: false, error: `Missing or empty required field: ${key}` });
        return;
      }
    }

    const setupTypeRaw = String(body.setup_type).trim();
    if (setupTypeRaw === 'replace_number') {
      const ft = body.forward_to_phone;
      if (ft === undefined || ft === null || String(ft).trim() === '') {
        res.status(400).json({ success: false, error: 'Missing or empty required field: forward_to_phone (required for Replace my number)' });
        return;
      }
    }

    const preferred_area_code = String(body.preferred_area_code).trim().replace(/\D/g, '').slice(0, 3);
    if (preferred_area_code.length !== 3) {
      res.status(400).json({ success: false, error: 'preferred_area_code must be a valid 3-digit area code' });
      return;
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!secretKey || !priceId) {
      console.error('[onboarding] STRIPE_SECRET_KEY or STRIPE_PRICE_ID not set');
      res.status(500).json({ success: false, error: 'Checkout is not configured' });
      return;
    }

    const stripe = new Stripe(secretKey);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: String(body.email).trim(),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${ONBOARDING_PAGE_ORIGIN}/onboarding.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${ONBOARDING_PAGE_ORIGIN}/onboarding.html?canceled=1`,
      metadata: {
        business_name: String(body.business_name).trim(),
        sender_name: body.sender_name != null ? String(body.sender_name).trim() : '',
        email: String(body.email).trim(),
        owner_phone: String(body.owner_phone).trim(),
        forward_to_phone: (body.forward_to_phone != null && String(body.forward_to_phone).trim() !== '') ? String(body.forward_to_phone).trim() : '',
        preferred_area_code,
        setup_type: String(body.setup_type).trim(),
        auto_reply_template: body.auto_reply_template != null ? String(body.auto_reply_template).trim() : '',
      },
    });

    const checkoutUrl = session.url;
    if (!checkoutUrl) {
      res.status(500).json({ success: false, error: 'Failed to create checkout session' });
      return;
    }

    res.status(200).json({ success: true, checkout_url: checkoutUrl });
  } catch (err) {
    console.error('[onboarding] Handler error', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

/**
 * GET /onboarding/success?session_id=cs_xxx
 *
 * Flow: Stripe redirects with ?session_id=cs_xxx → browser polls here until the webhook finishes
 * createBusinessWithNumber (Twilio + DB insert). Then we return the provisioned number.
 *
 * Response when ready (200):
 *   { "success": true, "leadlasso_number": "+1..." }
 * (Frontend also expects success === true; leadlasso_number is the Twilio E.164 from insert.)
 *
 * While webhook still running or session unknown (404):
 *   { "success": false, "error": "Business not ready yet" | ... }
 *
 * Lookup order:
 *   1) businesses.stripe_checkout_session_id = session_id (same id as URL; no Stripe API needed)
 *   2) Stripe sessions.retrieve → customer id → businesses.stripe_customer_id (legacy / fallback)
 */
export async function handleOnboardingSuccess(req: Request, res: Response): Promise<void> {
  try {
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
    if (!sessionId || !sessionId.startsWith('cs_')) {
      res.status(400).json({ success: false, error: 'Missing or invalid session_id' });
      return;
    }

    // 1) Direct match: webhook stores this Checkout Session id on the row we create.
    const { data: byCheckoutSession, error: errBySession } = await supabase
      .from('businesses')
      .select('leadlasso_number')
      .eq('stripe_checkout_session_id', sessionId)
      .limit(1)
      .maybeSingle();

    if (errBySession) {
      console.error('[onboarding] Success lookup by checkout session error', errBySession);
      res.status(500).json({ success: false, error: 'Lookup failed' });
      return;
    }
    if (byCheckoutSession?.leadlasso_number) {
      res.status(200).json({
        success: true,
        leadlasso_number: byCheckoutSession.leadlasso_number,
      });
      return;
    }

    // 2) Fallback: Stripe session → customer id → business (rows created before migration 006, or edge cases)
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      res.status(500).json({ success: false, error: 'Checkout is not configured' });
      return;
    }

    const stripe = new Stripe(secretKey);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
    if (!customerId) {
      console.warn('[onboarding] Success: session has no customer yet', { sessionId, payment_status: session.payment_status });
      res.status(404).json({ success: false, error: 'Session has no customer' });
      return;
    }

    const { data: business, error } = await supabase
      .from('businesses')
      .select('leadlasso_number')
      .eq('stripe_customer_id', customerId)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[onboarding] Success lookup by customer error', error);
      res.status(500).json({ success: false, error: 'Lookup failed' });
      return;
    }
    if (!business?.leadlasso_number) {
      res.status(404).json({ success: false, error: 'Business not ready yet' });
      return;
    }

    res.status(200).json({ success: true, leadlasso_number: business.leadlasso_number });
  } catch (err) {
    console.error('[onboarding] Success handler error', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
