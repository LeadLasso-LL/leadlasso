/**
 * Send SMS via Twilio. Used when forwarding to owner, replying to customer, or sending auto-reply.
 * All sends use the business's LeadLasso number as From so replies come back to the same webhook.
 */
import { twilioClient } from '../lib/twilio';
import { supabase } from '../lib/supabase';
import { persistConversationMessage, type MessageSenderType } from './message-history';

/**
 * Send one SMS. Caller is responsible for storing message in DB if needed (e.g. when we add messages table).
 */
export async function sendSms(params: {
  from: string;
  to: string;
  body: string;
}): Promise<{ sid: string }> {
  const result = await twilioClient.messages.create({
    from: params.from,
    to: params.to,
    body: params.body,
  });
  return { sid: result.sid };
}

const OPT_OUT_TEXT = 'Reply STOP to opt out.';

type SmsConsentStatus = 'subscribed' | 'unsubscribed' | 'unknown';

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && !phone.startsWith('+')) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

async function getCustomerSmsConsentStatus(customerPhone: string): Promise<SmsConsentStatus> {
  const customerE164 = toE164(customerPhone);
  try {
    const { data, error } = await supabase
      .from('outbound_customer_sms')
      .select('sms_consent_status')
      .eq('customer_phone', customerE164)
      .maybeSingle();
    if (error) {
      console.error('[sms][consent] lookup failed', error);
      return 'subscribed';
    }
    const status = (data?.sms_consent_status as SmsConsentStatus | null | undefined) ?? 'subscribed';
    return status === 'unsubscribed' ? 'unsubscribed' : status === 'unknown' ? 'unknown' : 'subscribed';
  } catch (err) {
    console.error('[sms][consent] unexpected lookup error', err);
    return 'subscribed';
  }
}

async function hasSentAnyOutboundToCustomer(customerPhone: string): Promise<boolean> {
  const customerE164 = toE164(customerPhone);
  const { data } = await supabase
    .from('outbound_customer_sms')
    .select('id')
    .eq('customer_phone', customerE164)
    .eq('has_sent_any_outbound', true)
    .maybeSingle();
  return !!data;
}

async function markOutboundSentToCustomer(customerPhone: string): Promise<void> {
  const customerE164 = toE164(customerPhone);
  try {
    // Only flips the "has ever sent" bit. Do not overwrite sms_consent_status here.
    await supabase
      .from('outbound_customer_sms')
      .upsert({ customer_phone: customerE164, has_sent_any_outbound: true }, { onConflict: 'customer_phone' });
  } catch (err) {
    // Best-effort: if the row already exists due to concurrency, we can safely ignore.
  }
}

/**
 * Send an outbound customer SMS and append opt-out language only on the first outbound SMS
 * ever sent to that unique customer phone number by this system.
 *
 * - Does not modify message content unless it's the first outbound and the opt-out text
 *   isn't already present.
 * - Uses the `outbound_customer_sms` table as a durable "has ever sent" marker.
 */
export async function sendCustomerSms(params: {
  from: string;
  to: string;
  body: string;
  messageMeta?: {
    conversationId: string;
    businessId: string;
    senderType: MessageSenderType;
  };
}): Promise<{ sid: string }> {
  const consent = await getCustomerSmsConsentStatus(params.to);
  if (consent === 'unsubscribed') {
    console.log('[sms][consent] suppressed outbound customer SMS — opted out', { to: params.to });
    return { sid: 'suppressed_optout' };
  }

  const alreadySent = await hasSentAnyOutboundToCustomer(params.to);

  const bodyAlreadyHasOptOut = params.body.includes(OPT_OUT_TEXT);
  const shouldAppendOptOut = !alreadySent && !bodyAlreadyHasOptOut;

  const separator = /[\s]$/.test(params.body) ? '' : ' ';
  const bodyToSend = shouldAppendOptOut ? params.body + separator + OPT_OUT_TEXT : params.body;

  const result = await sendSms({ from: params.from, to: params.to, body: bodyToSend });

  if (params.messageMeta) {
    await persistConversationMessage({
      conversationId: params.messageMeta.conversationId,
      businessId: params.messageMeta.businessId,
      customerPhone: toE164(params.to),
      direction: 'outbound',
      senderType: params.messageMeta.senderType,
      body: bodyToSend,
      channel: 'sms',
    });
  }

  if (!alreadySent) {
    // Mark only after successful send so we don't "steal" the first-message slot from retries.
    await markOutboundSentToCustomer(params.to);
  }

  return result;
}
