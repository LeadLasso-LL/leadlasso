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
import { ensureAuthUserAndLinkBusiness } from '../services/auth-provisioning';
import { sendWelcomeEmailForOnboarding } from '../services/email';
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

/**
 * Maps Stripe Checkout session.metadata (+ optional email from session) to onboarding body.
 * Shared by GET /onboarding/success and the Stripe webhook.
 */
export function onboardingBodyFromCheckoutMetadata(
  metadata: Record<string, string> | null | undefined,
  emailFallback?: string | null
): OnboardingBody | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const email =
    (metadata.email && String(metadata.email).trim()) ||
    (emailFallback && String(emailFallback).trim()) ||
    '';
  if (!email || !metadata.business_name || !metadata.owner_phone || !metadata.setup_type || !metadata.preferred_area_code) {
    return null;
  }
  const setupType = String(metadata.setup_type).trim() || '';
  if (setupType === 'replace_number' && (!metadata.forward_to_phone || String(metadata.forward_to_phone).trim() === '')) {
    return null;
  }
  return {
    business_name: String(metadata.business_name).trim(),
    sender_name: metadata.sender_name ? String(metadata.sender_name).trim() : undefined,
    email,
    owner_phone: String(metadata.owner_phone).trim(),
    forward_to_phone:
      metadata.forward_to_phone && String(metadata.forward_to_phone).trim() !== ''
        ? String(metadata.forward_to_phone).trim()
        : undefined,
    preferred_area_code: String(metadata.preferred_area_code).trim(),
    setup_type: String(metadata.setup_type).trim(),
    auto_reply_template:
      metadata.auto_reply_template && String(metadata.auto_reply_template).trim() !== ''
        ? String(metadata.auto_reply_template).trim()
        : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err && String((err as { code: string }).code) === '23505') {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('duplicate key') || msg.includes('23505') || msg.includes('unique constraint');
}

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

  const businessId = business?.id ?? '';
  const leadlassoNumber = business?.leadlasso_number ?? provisioned.phoneNumber;

  if (businessId) {
    const authResult = await ensureAuthUserAndLinkBusiness(businessId, email);
    try {
      await sendWelcomeEmailForOnboarding(data, leadlassoNumber, authResult.setPasswordUrl);
    } catch (emailErr) {
      console.error('[email] failed', emailErr);
    }
  }

  return {
    business_id: businessId,
    leadlasso_number: leadlassoNumber,
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
 * Self-contained: retrieves the Stripe Checkout Session, ensures the business row exists
 * (creates + provisions Twilio via createBusinessWithNumber if needed). Does not depend on
 * webhook timing. Idempotent for the same session_id / customer.
 *
 * 200: { success: true, leadlasso_number: "+1..." }
 */
export async function handleOnboardingSuccess(req: Request, res: Response): Promise<void> {
  try {
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
    if (!sessionId || !sessionId.startsWith('cs_')) {
      res.status(400).json({ success: false, error: 'Missing or invalid session_id' });
      return;
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      res.status(500).json({ success: false, error: 'Checkout is not configured' });
      return;
    }

    const stripe = new Stripe(secretKey);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    console.log('[onboarding] Success: retrieved checkout session', {
      sessionId,
      status: session.status,
      payment_status: session.payment_status,
    });

    if (session.status !== 'complete') {
      res.status(400).json({ success: false, error: 'Checkout session is not complete' });
      return;
    }
    if (session.payment_status !== 'paid') {
      res.status(400).json({ success: false, error: 'Payment not completed' });
      return;
    }

    const { data: bySessionRow, error: errBySession } = await supabase
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
    if (bySessionRow?.leadlasso_number) {
      console.log('[onboarding] Success: business already exists for session', sessionId);
      res.status(200).json({ success: true, leadlasso_number: bySessionRow.leadlasso_number });
      return;
    }

    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;

    if (customerId) {
      const { data: byCustomer, error: errCustomer } = await supabase
        .from('businesses')
        .select('leadlasso_number, stripe_checkout_session_id')
        .eq('stripe_customer_id', customerId)
        .limit(1)
        .maybeSingle();

      if (errCustomer) {
        console.error('[onboarding] Success lookup by customer error', errCustomer);
        res.status(500).json({ success: false, error: 'Lookup failed' });
        return;
      }
      if (byCustomer?.leadlasso_number) {
        if (!byCustomer.stripe_checkout_session_id) {
          const { error: patchErr } = await supabase
            .from('businesses')
            .update({ stripe_checkout_session_id: sessionId })
            .eq('stripe_customer_id', customerId);
          if (patchErr) {
            console.warn('[onboarding] Success: could not backfill stripe_checkout_session_id', patchErr);
          } else {
            console.log('[onboarding] Success: backfilled stripe_checkout_session_id for customer', customerId);
          }
        }
        console.log('[onboarding] Success: business already exists for customer', customerId);
        res.status(200).json({ success: true, leadlasso_number: byCustomer.leadlasso_number });
        return;
      }
    }

    const emailFallback = session.customer_email || session.customer_details?.email || null;
    const onboardingData = onboardingBodyFromCheckoutMetadata(
      session.metadata as Record<string, string> | null,
      emailFallback
    );
    if (!onboardingData) {
      res.status(400).json({ success: false, error: 'Checkout session is missing required onboarding metadata' });
      return;
    }

    try {
      const result = await createBusinessWithNumber(onboardingData, customerId, sessionId);
      console.log('[onboarding] Success: business created and number assigned', {
        sessionId,
        business_id: result.business_id,
        leadlasso_number: result.leadlasso_number,
      });
      res.status(200).json({ success: true, leadlasso_number: result.leadlasso_number });
    } catch (createErr) {
      if (isUniqueViolation(createErr)) {
        const { data: again } = await supabase
          .from('businesses')
          .select('leadlasso_number')
          .eq('stripe_checkout_session_id', sessionId)
          .maybeSingle();
        if (again?.leadlasso_number) {
          console.log('[onboarding] Success: idempotent return after unique conflict (session)', sessionId);
          res.status(200).json({ success: true, leadlasso_number: again.leadlasso_number });
          return;
        }
        if (customerId) {
          const { data: againCust } = await supabase
            .from('businesses')
            .select('leadlasso_number')
            .eq('stripe_customer_id', customerId)
            .maybeSingle();
          if (againCust?.leadlasso_number) {
            console.log('[onboarding] Success: idempotent return after unique conflict (customer)', customerId);
            res.status(200).json({ success: true, leadlasso_number: againCust.leadlasso_number });
            return;
          }
        }
      }
      console.error('[onboarding] Success: createBusinessWithNumber failed', createErr);
      const message = createErr instanceof Error ? createErr.message : String(createErr);
      res.status(500).json({ success: false, error: message });
    }
  } catch (err) {
    console.error('[onboarding] Success handler error', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
