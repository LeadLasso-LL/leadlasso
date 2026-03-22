/**
 * POST /webhooks/stripe
 * Handles Stripe events. On checkout.session.completed, provisions Twilio number and creates business.
 */
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase';
import { createBusinessWithNumber, onboardingBodyFromCheckoutMetadata } from '../routes/onboarding';
import { sendWelcomeEmail, type WelcomeEmailSetupType } from '../services/email';

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

  const onboardingData = onboardingBodyFromCheckoutMetadata(
    session.metadata as Record<string, string> | null,
    session.customer_email || session.customer_details?.email || null
  );
  if (!onboardingData) {
    console.error('[stripe] checkout.session.completed missing or invalid metadata');
    res.status(200).send();
    return;
  }

  let result: { business_id: string; leadlasso_number: string };
  try {
    result = await createBusinessWithNumber(onboardingData, customerId, session.id);
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
      email: String(onboardingData.email),
      leadlassoNumber: result.leadlasso_number,
      setupType,
      businessName: String(onboardingData.business_name),
      senderName: onboardingData.sender_name?.trim() || null,
      ownerPhone: String(onboardingData.owner_phone),
      forwardToPhone:
        onboardingData.forward_to_phone != null && String(onboardingData.forward_to_phone).trim() !== ''
          ? String(onboardingData.forward_to_phone).trim()
          : null,
      autoReplyTemplate: onboardingData.auto_reply_template ?? null,
    });
  } catch (err) {
    console.error('[stripe] Welcome email failed', err);
  }

  console.log('Welcome email triggered for:', onboardingData.email);

  res.status(200).send();
}
