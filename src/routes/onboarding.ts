/**
 * POST /onboarding/business — legacy Stripe Checkout flow
 * POST /api/onboarding/subscribe — Stripe Elements + Retell provisioning
 */
import { randomBytes } from 'crypto';
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { toBusinessInsertRow } from '../lib/business-insert';
import { supabase } from '../lib/supabase';
import type { BusinessHours, CallMode, OnboardingPlan, SetupType } from '../lib/supabase';
import { normalizePhone } from '../lib/phone';
import { ensureAuthUserAndLinkBusiness } from '../services/auth-provisioning';
import { passwordResetRedirectUrl, sendWelcomeEmailForOnboarding, sendWelcomeJuvoEmail } from '../services/email';
import { purchaseRetellPhoneNumber } from '../services/retell-provisioning';
import { provisionLocalNumber, releaseNumber } from '../services/twilio-provisioning';

/** Where users land after Stripe Checkout (must match hosted onboarding page). Not PUBLIC_BASE_URL (webhooks/TwiML). */
const ONBOARDING_PAGE_ORIGIN = 'https://start.getjuvo.io';

const REQUIRED = ['business_name', 'email', 'owner_phone', 'setup_type', 'preferred_area_code'] as const;

export type OnboardingBody = {
  business_name?: string;
  email?: string;
  owner_phone?: string;
  owner_sms_consent?: boolean | string;
  forward_to_phone?: string;
  setup_type?: string;
  preferred_area_code?: string;
  industry?: string | null;
};

function parseOwnerSmsConsent(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'n' || v === 'off') return false;
  }
  return undefined;
}

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
    email,
    owner_phone: String(metadata.owner_phone).trim(),
    owner_sms_consent: metadata.owner_sms_consent != null ? String(metadata.owner_sms_consent).trim() : undefined,
    forward_to_phone:
      metadata.forward_to_phone && String(metadata.forward_to_phone).trim() !== ''
        ? String(metadata.forward_to_phone).trim()
        : undefined,
    preferred_area_code: String(metadata.preferred_area_code).trim(),
    setup_type: String(metadata.setup_type).trim(),
    industry:
      metadata.industry && String(metadata.industry).trim() !== ''
        ? String(metadata.industry).trim()
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

export type CreateBusinessResult = { business_id: string; juvo_number: string };

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
  const owner_phone = normalizePhone(String(data.owner_phone).trim());
  const forward_to_phone_raw = data.forward_to_phone != null ? String(data.forward_to_phone).trim() : '';
  const existing_number =
    forward_to_phone_raw !== '' ? normalizePhone(forward_to_phone_raw) : null;
  const industry = data.industry != null ? String(data.industry).trim() || null : null;
  const preferred_area_code = String(data.preferred_area_code).trim().replace(/\D/g, '').slice(0, 3);
  const ownerSmsConsent = parseOwnerSmsConsent(data.owner_sms_consent);

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
    .insert(
      toBusinessInsertRow({
        email,
        business_name,
        owner_phone,
        existing_number,
        juvo_number: provisioned.phoneNumber,
        industry,
        setup_type,
        plan_status: 'active',
        stripe_customer_id: stripeCustomerId,
        stripe_checkout_session_id: stripeCheckoutSessionId ?? null,
        ...(ownerSmsConsent === false
          ? { owner_new_lead_alerts_enabled: false }
          : ownerSmsConsent === true
            ? { owner_new_lead_alerts_enabled: true }
            : {}),
      })
    )
    .select('id, juvo_number')
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
  const juvoNumber = business?.juvo_number ?? provisioned.phoneNumber;

  if (businessId) {
    const authResult = await ensureAuthUserAndLinkBusiness(businessId, email);
    try {
      await sendWelcomeEmailForOnboarding(data, juvoNumber, authResult.setPasswordUrl);
    } catch (emailErr) {
      console.error('[email] failed', emailErr);
    }
  }

  return {
    business_id: businessId,
    juvo_number: juvoNumber,
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
        email: String(body.email).trim(),
        owner_phone: String(body.owner_phone).trim(),
        owner_sms_consent: String(parseOwnerSmsConsent(body.owner_sms_consent) === true),
        forward_to_phone: (body.forward_to_phone != null && String(body.forward_to_phone).trim() !== '') ? String(body.forward_to_phone).trim() : '',
        preferred_area_code,
        setup_type: String(body.setup_type).trim(),
        industry: body.industry != null ? String(body.industry).trim() : '',
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
 * 200: { success: true, juvo_number: "+1..." }
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
      .select('juvo_number')
      .eq('stripe_checkout_session_id', sessionId)
      .limit(1)
      .maybeSingle();

    if (errBySession) {
      console.error('[onboarding] Success lookup by checkout session error', errBySession);
      res.status(500).json({ success: false, error: 'Lookup failed' });
      return;
    }
    if (bySessionRow?.juvo_number) {
      console.log('[onboarding] Success: business already exists for session', sessionId);
      res.status(200).json({ success: true, juvo_number: bySessionRow.juvo_number });
      return;
    }

    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;

    if (customerId) {
      const { data: byCustomer, error: errCustomer } = await supabase
        .from('businesses')
        .select('juvo_number, stripe_checkout_session_id')
        .eq('stripe_customer_id', customerId)
        .limit(1)
        .maybeSingle();

      if (errCustomer) {
        console.error('[onboarding] Success lookup by customer error', errCustomer);
        res.status(500).json({ success: false, error: 'Lookup failed' });
        return;
      }
      if (byCustomer?.juvo_number) {
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
        res.status(200).json({ success: true, juvo_number: byCustomer.juvo_number });
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
        juvo_number: result.juvo_number,
      });
      res.status(200).json({ success: true, juvo_number: result.juvo_number });
    } catch (createErr) {
      if (isUniqueViolation(createErr)) {
        const { data: again } = await supabase
          .from('businesses')
          .select('juvo_number')
          .eq('stripe_checkout_session_id', sessionId)
          .maybeSingle();
        if (again?.juvo_number) {
          console.log('[onboarding] Success: idempotent return after unique conflict (session)', sessionId);
          res.status(200).json({ success: true, juvo_number: again.juvo_number });
          return;
        }
        if (customerId) {
          const { data: againCust } = await supabase
            .from('businesses')
            .select('juvo_number')
            .eq('stripe_customer_id', customerId)
            .maybeSingle();
          if (againCust?.juvo_number) {
            console.log('[onboarding] Success: idempotent return after unique conflict (customer)', customerId);
            res.status(200).json({ success: true, juvo_number: againCust.juvo_number });
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

// ── Stripe Elements subscribe flow (GET /onboarding template) ──

export type SubscribeBody = {
  business_name?: string;
  first_name?: string;
  email?: string;
  owner_phone?: string;
  preferred_area_code?: string;
  industry?: string | null;
  sms_opt_in?: boolean;
  call_mode?: string;
  existing_number?: string | null;
  business_hours?: BusinessHours | null;
  plan?: string;
  payment_method_id?: string;
};

const SUBSCRIBE_REQUIRED = [
  'business_name',
  'first_name',
  'email',
  'owner_phone',
  'preferred_area_code',
  'call_mode',
  'plan',
  'payment_method_id',
] as const;

function normalizeCallMode(raw: string): CallMode | null {
  const v = raw.trim().toLowerCase().replace(/-/g, '_');
  if (v === 'ai_first') return 'ai_first';
  if (v === 'human_first') return 'human_first';
  return null;
}

function normalizePlan(raw: string): OnboardingPlan | null {
  const v = raw.trim().toLowerCase();
  if (v === 'starter' || v === '97') return 'starter';
  if (v === 'pro' || v === '197') return 'pro';
  return null;
}

function callModeToSetupType(callMode: CallMode): SetupType {
  return callMode === 'human_first' ? 'forwarding' : 'replace_number';
}

function planLabel(plan: OnboardingPlan): string {
  return plan === 'starter' ? 'Starter ($97/mo)' : 'Pro ($197/mo)';
}

function callModeLabel(callMode: CallMode): string {
  return callMode === 'human_first' ? 'Human First' : 'AI First';
}

function resolveRetellAgentId(plan: OnboardingPlan, callMode: CallMode): string | null {
  const keys: Record<string, string | undefined> = {
    starter_ai_first: process.env.RETELL_AGENT_STARTER_AI_FIRST,
    starter_human_first: process.env.RETELL_AGENT_STARTER_HUMAN_FIRST,
    pro_ai_first: process.env.RETELL_AGENT_PRO_AI_FIRST,
    pro_human_first: process.env.RETELL_AGENT_PRO_HUMAN_FIRST,
  };
  const key = `${plan}_${callMode}`;
  const id = keys[key]?.trim();
  return id || null;
}

function resolveStripePriceId(plan: OnboardingPlan): string | null {
  const id =
    plan === 'starter'
      ? process.env.STRIPE_STARTER_PRICE_ID?.trim()
      : process.env.STRIPE_PRO_PRICE_ID?.trim();
  return id || null;
}

function parseBusinessHours(raw: unknown): BusinessHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as BusinessHours;
}

type GenerateLinkResponse = {
  user?: { id?: string };
  properties?: { action_link?: string };
};

function extractActionLink(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const link = (data as GenerateLinkResponse).properties?.action_link;
  return link?.trim() || null;
}

function extractUserIdFromLinkData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  return (data as GenerateLinkResponse).user?.id ?? null;
}

/**
 * Creates auth user via signup link (longer-lived) and returns Supabase action_link for welcome email.
 */
function randomInitialPassword(): string {
  return randomBytes(24).toString('base64url');
}

async function provisionSignupPasswordLink(
  email: string,
  metadata: { first_name: string; business_name: string }
): Promise<{ userId: string | null; setPasswordUrl: string | null }> {
  const redirectTo = passwordResetRedirectUrl();

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'signup',
    email,
    password: randomInitialPassword(),
    options: {
      redirectTo,
      data: metadata,
    },
  });

  if (!error && data) {
    const setPasswordUrl = extractActionLink(data);
    console.log('[onboarding] signup generateLink ok', {
      userId: extractUserIdFromLinkData(data),
      hasActionLink: Boolean(setPasswordUrl),
      redirectTo,
      actionLinkHost: setPasswordUrl ? new URL(setPasswordUrl).host : null,
    });
    return {
      userId: extractUserIdFromLinkData(data),
      setPasswordUrl,
    };
  }

  const errMsg = String(error?.message || '').toLowerCase();
  const userExists =
    errMsg.includes('already') ||
    errMsg.includes('registered') ||
    errMsg.includes('exists') ||
    error?.status === 422;

  if (userExists) {
    console.log('[onboarding] signup generateLink user exists, falling back to recovery link');
    const { data: listed } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    const existing = listed?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());

    const recovery = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    });
    if (!recovery.error && recovery.data) {
      return {
        userId: existing?.id ?? null,
        setPasswordUrl: extractActionLink(recovery.data),
      };
    }
    console.error('[onboarding] recovery generateLink failed', recovery.error);
    return { userId: existing?.id ?? null, setPasswordUrl: null };
  }

  console.error('[onboarding] signup generateLink failed', error);
  return { userId: null, setPasswordUrl: null };
}

function subscriptionPaymentError(subscription: Stripe.Subscription): string | null {
  const status = subscription.status;
  if (status === 'active' || status === 'trialing') return null;

  const invoice = subscription.latest_invoice;
  if (invoice && typeof invoice === 'object' && 'payment_intent' in invoice) {
    const pi = (invoice as Stripe.Invoice).payment_intent;
    if (pi && typeof pi === 'object' && 'last_payment_error' in pi) {
      const err = (pi as Stripe.PaymentIntent).last_payment_error;
      if (err?.message) return err.message;
    }
  }

  if (status === 'incomplete' || status === 'past_due' || status === 'unpaid') {
    return 'Payment could not be completed. Please check your card and try again.';
  }
  return `Subscription status: ${status}`;
}

export async function handleOnboardingSubscribe(req: Request, res: Response): Promise<void> {
  let provisionedPhone: string | null = null;

  try {
    const body = (req.body || {}) as SubscribeBody;

    for (const key of SUBSCRIBE_REQUIRED) {
      const val = body[key];
      if (val === undefined || val === null || String(val).trim() === '') {
        res.status(400).json({ success: false, error: `Missing required field: ${key}` });
        return;
      }
    }

    const callMode = normalizeCallMode(String(body.call_mode));
    if (!callMode) {
      res.status(400).json({ success: false, error: 'Invalid call_mode' });
      return;
    }

    const plan = normalizePlan(String(body.plan));
    if (!plan) {
      res.status(400).json({ success: false, error: 'Invalid plan' });
      return;
    }

    const business_name = String(body.business_name).trim();
    const first_name = String(body.first_name).trim();
    const email = String(body.email).trim().toLowerCase();
    const owner_phone = normalizePhone(String(body.owner_phone).trim());
    const preferred_area_code = String(body.preferred_area_code).trim().replace(/\D/g, '').slice(0, 3);
    if (preferred_area_code.length !== 3) {
      res.status(400).json({ success: false, error: 'preferred_area_code must be a valid 3-digit area code' });
      return;
    }

    const industry =
      body.industry != null && String(body.industry).trim() !== ''
        ? String(body.industry).trim()
        : null;

    const sms_opt_in = body.sms_opt_in === true;

    let existing_number: string | null = null;
    if (callMode === 'human_first') {
      const rawExisting = body.existing_number;
      if (!rawExisting || String(rawExisting).trim() === '') {
        res.status(400).json({
          success: false,
          error: 'existing_number is required when call_mode is human_first',
        });
        return;
      }
      existing_number = normalizePhone(String(rawExisting).trim());
    }

    const business_hours =
      callMode === 'human_first' ? parseBusinessHours(body.business_hours) : null;

    const paymentMethodId = String(body.payment_method_id).trim();
    const priceId = resolveStripePriceId(plan);
    const agentId = resolveRetellAgentId(plan, callMode);

    const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!secretKey || !priceId) {
      console.error('[onboarding] subscribe missing STRIPE_SECRET_KEY or price id');
      res.status(500).json({ success: false, error: 'Billing is not configured' });
      return;
    }
    if (!agentId) {
      console.error('[onboarding] subscribe missing Retell agent env for', plan, callMode);
      res.status(500).json({ success: false, error: 'Voice agent is not configured' });
      return;
    }

    const stripe = new Stripe(secretKey);
    const customerName = `${first_name} — ${business_name}`;

    const customer = await stripe.customers.create({
      email,
      name: customerName,
      metadata: { business_name, plan, call_mode: callMode },
    });

    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    } catch (attachErr) {
      const message = attachErr instanceof Error ? attachErr.message : 'Invalid payment method';
      res.status(402).json({ success: false, error: message });
      return;
    }

    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: priceId }],
        default_payment_method: paymentMethodId,
        payment_behavior: 'error_if_incomplete',
        expand: ['latest_invoice.payment_intent'],
      });
    } catch (subErr) {
      const message =
        subErr instanceof Error ? subErr.message : 'Payment could not be completed';
      console.error('[onboarding] subscribe subscription failed', subErr);
      res.status(402).json({ success: false, error: message });
      return;
    }

    const paymentError = subscriptionPaymentError(subscription);
    if (paymentError) {
      res.status(402).json({ success: false, error: paymentError });
      return;
    }

    try {
      const purchased = await purchaseRetellPhoneNumber({
        areaCode: parseInt(preferred_area_code, 10),
        agentId,
      });
      provisionedPhone = purchased.phoneNumber;
    } catch (retellErr) {
      console.error('[onboarding] subscribe Retell provision failed after payment', retellErr);
      res.status(500).json({
        success: false,
        error: 'Payment succeeded but phone provisioning failed. Our team will follow up shortly.',
        stripe_customer_id: customer.id,
        stripe_subscription_id: subscription.id,
      });
      return;
    }

    let userId: string | null = null;
    let setPasswordUrl: string | null = null;

    try {
      const authResult = await provisionSignupPasswordLink(email, {
        first_name,
        business_name,
      });
      userId = authResult.userId;
      setPasswordUrl = authResult.setPasswordUrl;
      if (!setPasswordUrl) {
        console.warn('[onboarding] subscribe missing action_link for welcome email');
      }
    } catch (authBlockErr) {
      console.error('[onboarding] subscribe auth block failed', authBlockErr);
    }

    const setup_type = callModeToSetupType(callMode);

    try {
      const { error: insertErr } = await supabase.from('businesses').insert(
        toBusinessInsertRow({
          email,
          user_id: userId,
          business_name,
          first_name,
          owner_phone,
          existing_number,
          juvo_number: provisionedPhone,
          industry,
          call_mode: callMode,
          business_hours,
          sms_opt_in,
          setup_type,
          plan_status: 'active',
          retell_agent_id: agentId,
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription.id,
          owner_new_lead_alerts_enabled: sms_opt_in,
        })
      );

      if (insertErr) {
        console.error('[onboarding] subscribe business insert failed', insertErr);
        res.status(500).json({
          success: false,
          error: 'Payment succeeded but account setup failed. Our team will follow up shortly.',
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription.id,
        });
        return;
      }
    } catch (dbErr) {
      console.error('[onboarding] subscribe business insert threw', dbErr);
      res.status(500).json({
        success: false,
        error: 'Payment succeeded but account setup failed. Our team will follow up shortly.',
        stripe_customer_id: customer.id,
        stripe_subscription_id: subscription.id,
      });
      return;
    }

    try {
      await sendWelcomeJuvoEmail({
        email,
        firstName: first_name,
        businessName: business_name,
        juvoNumber: provisionedPhone,
        planLabel: planLabel(plan),
        callModeLabel: callModeLabel(callMode),
        setPasswordUrl,
      });
    } catch (emailErr) {
      console.error('[onboarding] subscribe welcome email failed', emailErr);
    }

    res.status(200).json({
      success: true,
      phone_number: provisionedPhone,
      set_password_url: setPasswordUrl,
    });
  } catch (err) {
    console.error('[onboarding] subscribe error', err);
    if (provisionedPhone) {
      res.status(200).json({ success: true, phone_number: provisionedPhone });
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
