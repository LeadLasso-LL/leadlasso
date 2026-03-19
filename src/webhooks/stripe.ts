/**
 * POST /webhooks/stripe
 * Handles Stripe events. On checkout.session.completed, provisions Twilio number and creates business.
 */
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase';
import { createBusinessWithNumber, type OnboardingBody } from '../routes/onboarding';
import { sendWelcomeEmail, type WelcomeEmailSetupType } from '../services/email';

function metadataToOnboardingBody(metadata: Record<string, string> | null): OnboardingBody | null {
  if (!metadata || !metadata.business_name || !metadata.email || !metadata.owner_phone || !metadata.setup_type || !metadata.preferred_area_code) {
    return null;
  }
  const setupType = metadata.setup_type?.trim() || '';
  if (setupType === 'replace_number' && (!metadata.forward_to_phone || String(metadata.forward_to_phone).trim() === '')) {
    return null;
  }
  return {
    business_name: metadata.business_name,
    sender_name: metadata.sender_name || undefined,
    email: metadata.email,
    owner_phone: metadata.owner_phone,
    forward_to_phone: metadata.forward_to_phone && String(metadata.forward_to_phone).trim() !== '' ? metadata.forward_to_phone : undefined,
    preferred_area_code: metadata.preferred_area_code,
    setup_type: metadata.setup_type,
    auto_reply_template: metadata.auto_reply_template && metadata.auto_reply_template.trim() !== '' ? metadata.auto_reply_template : null,
  };
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !webhookSecret) {
    res.status(400).send('Missing stripe-signature or STRIPE_WEBHOOK_SECRET');
    return;
  }

  let event: Stripe.Event;
  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).send('Invalid body');
    return;
  }
  try {
    event = Stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe] Webhook signature verification failed', message);
    res.status(400).send(`Webhook Error: ${message}`);
    return;
  }

  console.log('Stripe webhook received:', event.type);

  if (event.type !== 'checkout.session.completed') {
    res.status(200).send();
    return;
  }

  console.log('Processing checkout.session.completed event');

  const session = event.data.object as Stripe.Checkout.Session;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
  if (!customerId) {
    console.error('[stripe] checkout.session.completed missing customer');
    res.status(200).send();
    return;
  }

  const { data: existing } = await supabase
    .from('businesses')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .limit(1)
    .maybeSingle();

  if (existing) {
    res.status(200).send();
    return;
  }

  const onboardingData = metadataToOnboardingBody(session.metadata as Record<string, string> | null);
  if (!onboardingData) {
    console.error('[stripe] checkout.session.completed missing or invalid metadata');
    res.status(200).send();
    return;
  }

  let result: { business_id: string; leadlasso_number: string };
  try {
    result = await createBusinessWithNumber(onboardingData, customerId);
  } catch (err) {
    console.error('[stripe] createBusinessWithNumber failed', err);
    res.status(500).send('Internal error');
    return;
  }

  console.log('LeadLasso number provisioned:', result.leadlasso_number);

  const setupTypeRaw = onboardingData.setup_type?.trim() || '';
  const setupType: WelcomeEmailSetupType =
    setupTypeRaw === 'forward' || setupTypeRaw === 'forwarding' ? 'forwarding' : 'replace_number';
  try {
    await sendWelcomeEmail({
      firstName: onboardingData.sender_name?.trim() || 'there',
      email: onboardingData.email as string,
      leadlassoNumber: result.leadlasso_number,
      setupType,
    });
  } catch (err) {
    console.error('[stripe] Welcome email failed', err);
  }

  console.log('Welcome email triggered for:', onboardingData.email);

  res.status(200).send();
}
