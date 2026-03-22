/**
 * POST /webhooks/incoming-call
 *
 * Normal flow: customer calls the LeadLasso number → we identify the business by To (that number)
 * and either ring the owner (replace_number) or treat the forwarded call as missed (forwarding).
 *
 * Logic (skeleton — full behavior in later phase):
 * 1. Identify business by To (leadlasso_number). If none or inactive → Reject (ignore).
 * 2. If setup_type === 'replace_number': TwiML Dial owner_phone; on no-answer, dial-action sends auto-reply SMS.
 * 3. If setup_type === 'forwarding': do not answer (Reject); send auto-reply SMS to caller (forwarded call = missed).
 *
 * We do not assume the customer texts first; the call is the normal entry point.
 *
 * This same route receives Twilio voice status callbacks (CallStatus: completed, no-answer, busy, failed).
 * When a call is missed (no-answer, busy, failed):
 * 1) Prepare conversation + code for this caller (same code used when they text back).
 * 2) Send auto-reply SMS to the caller.
 * 3) If owner SMS number ≠ missed-call line (see shouldSendImmediateMissedCallOwnerAlert), send immediate owner alert.
 * Twilio retries: customer SMS deduped by CallSid; owner alert retried if first attempt failed.
 */
import { Request, Response } from 'express';
import type { BusinessRow } from '../lib/supabase';
import { findBusinessByLeadlassoNumber, isBusinessActive } from '../services/business';
import {
  prepareConversationForMissedCall,
  getConversationCodeForBusinessCustomer,
} from '../services/conversation';
import { sendCustomerSms, sendSms } from '../services/sms';
import { insertLeadForMissedCall } from '../services/leads';

/** Empty TwiML — we do not reject or modify the call; status callback handles missed-call SMS. */
const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Forward mode: end the forwarded call immediately so status callback can trigger missed-call SMS (no second ring). */
const FORWARD_REJECT_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';

function buildDialTwiml(ownerPhone: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20">${ownerPhone}</Dial></Response>`;
}

/** CallSids we have already sent a missed-call SMS for (prevents duplicate on Twilio retries). */
const processedCallSids = new Set<string>();

/** CallSids for which the immediate owner missed-call alert SMS was sent (separate from customer SMS dedup for retries). */
const processedOwnerMissedCallAlertSids = new Set<string>();

/**
 * Immediate owner alert is redundant when the owner's SMS number is the same line that missed the call.
 * replace_number: call rings owner_phone — skip. forwarding: compare owner_phone to forward_to_phone when set.
 */
function shouldSendImmediateMissedCallOwnerAlert(business: BusinessRow): boolean {
  const owner = normalizePhone(business.owner_phone);
  if (business.setup_type === 'replace_number') {
    const ringDest = normalizePhone(business.owner_phone);
    return owner !== ringDest;
  }
  if (business.setup_type === 'forwarding') {
    const ft = business.forward_to_phone?.trim();
    if (!ft) return true;
    return owner !== normalizePhone(ft);
  }
  return true;
}

function buildImmediateOwnerMissedCallAlertBody(leadCode: string, callerNumber: string): string {
  return `New missed call lead ${leadCode}\nFrom: ${callerNumber}\n\nLeadLasso just texted them instantly.\n\nWe'll send their response here, or you can call them back now.`;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && !phone.startsWith('+')) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/**
 * Handles Twilio voice status webhooks. When call is no-answer, busy, or failed,
 * sends auto-reply SMS to the caller (unless caller is the owner).
 */
async function handleIncomingCallStatus(req: Request, res: Response): Promise<void> {
  const callSid = req.body.CallSid as string;
  const callStatus = req.body.CallStatus as string;
  const from = req.body.From as string;
  const to = req.body.To as string;

  console.log('[call] Status callback received');
  console.log('[call] CallSid:', callSid);
  console.log('[call] From:', from);
  console.log('[call] To:', to);
  console.log('[call] Status:', callStatus);

  if (callStatus === 'completed') {
    res.status(200).end();
    return;
  }

  if (callStatus !== 'no-answer' && callStatus !== 'busy' && callStatus !== 'failed') {
    res.status(200).end();
    return;
  }

  const business = await findBusinessByLeadlassoNumber(to);
  if (!business) {
    console.log('[call] Business not found for number');
    res.status(200).end();
    return;
  }

  const fromNormalized = normalizePhone(from);
  const ownerNormalized = normalizePhone(business.owner_phone);
  if (fromNormalized === ownerNormalized) {
    console.log('[call] Owner call ignored');
    res.status(200).end();
    return;
  }

  const replyText =
    business.auto_reply_template ??
    `Sorry we missed your call! This is ${business.sender_name ?? 'us'} with ${business.business_name}. How can we help today?`;

  if (!business.leadlasso_number) {
    res.status(200).end();
    return;
  }

  const customerSmsAlreadySent = processedCallSids.has(callSid);

  if (!customerSmsAlreadySent) {
    let prepCode: string | null = null;
    try {
      const prep = await prepareConversationForMissedCall(business, from);
      prepCode = prep?.code ?? null;
    } catch (err) {
      console.error('[call] prepareConversationForMissedCall failed', err);
    }

    await sendCustomerSms({
      from: business.leadlasso_number,
      to: from,
      body: replyText,
    });
    processedCallSids.add(callSid);

    void insertLeadForMissedCall(business.id, fromNormalized);

    if (
      shouldSendImmediateMissedCallOwnerAlert(business) &&
      prepCode &&
      !processedOwnerMissedCallAlertSids.has(callSid)
    ) {
      try {
        await sendSms({
          from: business.leadlasso_number,
          to: business.owner_phone,
          body: buildImmediateOwnerMissedCallAlertBody(prepCode, from),
        });
        processedOwnerMissedCallAlertSids.add(callSid);
        console.log('[call] Immediate owner missed-call alert sent');
      } catch (err) {
        console.error('[call] Immediate owner missed-call alert failed', err);
      }
    }
  } else {
    // Twilio retry after customer SMS succeeded: deliver owner alert if it failed the first time.
    if (
      shouldSendImmediateMissedCallOwnerAlert(business) &&
      !processedOwnerMissedCallAlertSids.has(callSid)
    ) {
      try {
        const code = await getConversationCodeForBusinessCustomer(business.id, from);
        if (code) {
          await sendSms({
            from: business.leadlasso_number,
            to: business.owner_phone,
            body: buildImmediateOwnerMissedCallAlertBody(code, from),
          });
          processedOwnerMissedCallAlertSids.add(callSid);
          console.log('[call] Immediate owner missed-call alert sent (retry)');
        }
      } catch (err) {
        console.error('[call] Immediate owner missed-call alert retry failed', err);
      }
    }
    console.log('[call] Duplicate webhook ignored (customer SMS already sent)');
  }

  console.log('[call] Business found: true');
  console.log('[call] Missed call detected');
  if (!customerSmsAlreadySent) console.log('[sms] Auto-text sent');
  res.status(200).end();
}

export async function handleIncomingCall(req: Request, res: Response): Promise<void> {
  const callStatus = req.body.CallStatus as string | undefined;
  if (
    callStatus &&
    (callStatus === 'completed' || callStatus === 'no-answer' || callStatus === 'busy' || callStatus === 'failed')
  ) {
    return handleIncomingCallStatus(req, res);
  }

  console.log('[incoming-call] Webhook received');
  const to = req.body.To as string;
  const from = req.body.From as string;
  console.log('[call] From:', from);
  console.log('[call] To:', to);

  const business = await findBusinessByLeadlassoNumber(to);
  console.log('[call] Business found:', !!business);
  if (business) {
    console.log('[call] Business name:', business.business_name);
    console.log('[call] setup_type:', business.setup_type);
  }
  if (!business) {
    console.log('[call] Business not found for number');
    res.type('text/xml').status(200).send(EMPTY_TWIML);
    return;
  }
  if (!isBusinessActive(business) || !business.leadlasso_number) {
    console.log('[call] Business inactive or no leadlasso number');
    res.type('text/xml').status(200).send(EMPTY_TWIML);
    return;
  }

  if (business.setup_type === 'replace_number') {
    console.log('[call] Replace number mode: dialing destination phone');
    res.type('text/xml').status(200).send(buildDialTwiml(business.owner_phone));
    return;
  }

  console.log('[call] Forward mode: treating forwarded call as missed');
  res.type('text/xml').status(200).send(FORWARD_REJECT_TWIML);
  return;
}

/**
 * Called by Twilio when the Dial to the owner ends (no-answer, completed, etc.).
 * Skeleton: just hang up. Later: if no-answer, send auto-reply SMS to caller.
 */
export async function handleIncomingCallDialAction(req: Request, res: Response): Promise<void> {
  res.type('text/xml').status(200).send(EMPTY_TWIML);
}
