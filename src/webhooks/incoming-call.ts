/**
 * POST /webhooks/incoming-call
 *
 * Normal flow: customer calls the LeadLasso number → identify business by To (leadlasso_number).
 * replace_number: TwiML Dial forward_to_phone (fallback owner_phone if unset — legacy rows).
 * forwarding: Reject so the forwarded leg ends; final status callback drives follow-up.
 *
 * Missed-call SMS, lead creation, and owner alert run ONLY from the final Twilio voice status
 * callback (see handleIncomingCallStatusCallback), using CallStatus, CallDuration, and AnsweredBy.
 *
 * POST /webhooks/incoming-call/status — same handler for new number provisioning (statusCallback URL).
 */
import { Request, Response } from 'express';
import type { BusinessRow } from '../lib/supabase';
import { findBusinessByLeadlassoNumber, isBusinessActive } from '../services/business';
import {
  findOrCreateConversation,
  prepareConversationForMissedCall,
  getConversationCodeForBusinessCustomer,
} from '../services/conversation';
import { sendCustomerSms, sendSms } from '../services/sms';
import {
  ensureMissedCallLead,
  markLeadAutoReplySent,
  markLeadOwnerMissedCallAlertSent,
} from '../services/leads';
import {
  evaluateMissedCallFollowUp,
  isTerminalCallStatus,
  parseCallDurationSeconds,
} from '../services/call-outcome';
import { isOwnerNewLeadAlertsEnabled } from '../services/owner-alerts';

/** Empty TwiML — legacy forwarding or mid-call status posts that must not re-run Dial. */
const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const FORWARD_REJECT_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * replace_number: ring this destination on Dial leg with Twilio AMD so AnsweredBy is populated on status callbacks.
 * @see https://www.twilio.com/docs/voice/twiml/number#machine-detection
 */
function buildDialTwiml(dialDestination: string): string {
  const num = escapeXmlText(normalizePhone(dialDestination));
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20"><Number machineDetection="Enable">${num}</Number></Dial></Response>`;
}

/**
 * Where inbound calls are routed for replace_number accounts.
 * forward_to_phone when set; otherwise owner_phone (legacy / single-field rows).
 */
function getReplaceNumberDialDestination(business: BusinessRow): string {
  const ft = business.forward_to_phone?.trim();
  if (ft) return normalizePhone(ft);
  return normalizePhone(business.owner_phone);
}

/** Route status posts that should run the voice URL handler (legacy: statusCallback === voice URL). */
const STATUS_ROUTED_TO_VOICE_URL = new Set([
  'completed',
  'no-answer',
  'busy',
  'failed',
  'canceled',
]);

function shouldSendImmediateMissedCallOwnerAlert(business: BusinessRow): boolean {
  const owner = normalizePhone(business.owner_phone);
  if (business.setup_type === 'replace_number') {
    const ringDest = getReplaceNumberDialDestination(business);
    return owner !== ringDest;
  }
  if (business.setup_type === 'forwarding') {
    const ft = business.forward_to_phone?.trim();
    if (!ft) return true;
    return owner !== normalizePhone(ft);
  }
  return true;
}

/** Immediate missed-call owner SMS: routing rules + portal preference. */
function shouldSendNewMissedCallOwnerText(business: BusinessRow): boolean {
  return shouldSendImmediateMissedCallOwnerAlert(business) && isOwnerNewLeadAlertsEnabled(business);
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
 * Final Twilio voice status callback: decide missed vs handled, then idempotent lead + SMS + owner alert.
 */
export async function handleIncomingCallStatusCallback(req: Request, res: Response): Promise<void> {
  const callSid = String(req.body.CallSid ?? '').trim();
  const callStatusRaw = String(req.body.CallStatus ?? '').trim();
  const callStatus = callStatusRaw.toLowerCase();
  const from = req.body.From as string;
  const to = req.body.To as string;
  const durationSec = parseCallDurationSeconds(req.body.CallDuration);
  const answeredByRaw = req.body.AnsweredBy;
  const answeredBy =
    answeredByRaw != null && String(answeredByRaw).trim() !== '' ? String(answeredByRaw).trim() : undefined;

  console.log('[call] final callback received');
  console.log('[call] status:', callStatusRaw || '(empty)');
  console.log('[call] duration:', durationSec);
  if (answeredBy !== undefined) {
    console.log('[call] answeredBy:', answeredBy);
  } else {
    console.log('[call] answeredBy: (not provided)');
  }

  if (!isTerminalCallStatus(callStatus)) {
    res.status(200).end();
    return;
  }

  const evaluation = evaluateMissedCallFollowUp({
    callStatus,
    callDurationSeconds: durationSec,
    answeredBy,
  });

  if (evaluation.action === 'handled') {
    console.log('[call] treated as handled');
    res.status(200).end();
    return;
  }

  if (evaluation.action === 'ignore') {
    res.status(200).end();
    return;
  }

  if (evaluation.reason === 'no-answer/busy/failed/canceled') {
    console.log('[call] treated as missed (reason: no-answer/busy/failed/canceled)');
  } else if (evaluation.reason === 'short completed call <20s') {
    console.log('[call] treated as missed (reason: short completed call <20s)');
  } else {
    console.log('[call] treated as missed (reason: machine/voicemail)');
  }

  if (!callSid) {
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
  const dialDestNormalized =
    business.setup_type === 'replace_number'
      ? getReplaceNumberDialDestination(business)
      : null;
  if (
    fromNormalized === ownerNormalized ||
    (dialDestNormalized != null && fromNormalized === dialDestNormalized)
  ) {
    console.log('[call] Owner call ignored');
    res.status(200).end();
    return;
  }

  if (!business.leadlasso_number) {
    res.status(200).end();
    return;
  }

  const replyText =
    business.auto_reply_template ??
    `Sorry we missed your call! This is ${business.sender_name ?? 'us'} with ${business.business_name}. How can we help today?`;

  const leadResult = await ensureMissedCallLead(business.id, from, callSid);
  if (!leadResult) {
    res.status(200).end();
    return;
  }

  const { row: leadRow, inserted } = leadResult;

  if (inserted) {
    console.log('[call] lead created');
  }

  const alreadyFullyProcessed =
    leadRow.auto_reply_sent_at != null &&
    (!shouldSendNewMissedCallOwnerText(business) || leadRow.owner_missed_call_alert_sent_at != null);

  if (alreadyFullyProcessed) {
    console.log('[call] skipped duplicate processing for CallSid');
    res.status(200).end();
    return;
  }

  let prepCode: string | null = null;
  let conversationIdForSystemOutbound: string | null = null;
  if (!leadRow.auto_reply_sent_at) {
    try {
      const prep = await prepareConversationForMissedCall(business, from);
      prepCode = prep?.code ?? null;
      conversationIdForSystemOutbound = prep?.id ?? null;
    } catch (err) {
      console.error('[call] prepareConversationForMissedCall failed', err);
    }

    if (!conversationIdForSystemOutbound) {
      try {
        const resolved = await findOrCreateConversation(business, from);
        conversationIdForSystemOutbound = resolved.conversation.id;
        if (!prepCode) {
          prepCode = resolved.conversation.conversation_code ?? null;
        }
      } catch (err) {
        console.error('[call] findOrCreateConversation fallback failed', err);
      }
    }

    try {
      await sendCustomerSms({
        from: business.leadlasso_number,
        to: from,
        body: replyText,
        messageMeta:
          conversationIdForSystemOutbound != null
            ? {
                conversationId: conversationIdForSystemOutbound,
                businessId: business.id,
                senderType: 'system',
              }
            : undefined,
      });
      await markLeadAutoReplySent(leadRow.id);
      console.log('[call] follow-up SMS sent');
    } catch (err) {
      console.error('[call] follow-up SMS failed', err);
    }
  }

  if (shouldSendImmediateMissedCallOwnerAlert(business) && !isOwnerNewLeadAlertsEnabled(business)) {
    console.log('[owner alerts] skipped new lead alert — preference disabled');
  }

  if (shouldSendNewMissedCallOwnerText(business) && !leadRow.owner_missed_call_alert_sent_at) {
    const code =
      prepCode ?? (await getConversationCodeForBusinessCustomer(business.id, from));
    if (code) {
      try {
        await sendSms({
          from: business.leadlasso_number,
          to: business.owner_phone,
          body: buildImmediateOwnerMissedCallAlertBody(code, from),
        });
        await markLeadOwnerMissedCallAlertSent(leadRow.id);
        console.log('[call] Immediate owner missed-call alert sent');
      } catch (err) {
        console.error('[call] Immediate owner missed-call alert failed', err);
      }
    }
  }

  res.status(200).end();
}

export async function handleIncomingCall(req: Request, res: Response): Promise<void> {
  const callStatusRaw = req.body.CallStatus as string | undefined;
  const callStatus = callStatusRaw?.trim().toLowerCase() ?? '';

  if (callStatusRaw && STATUS_ROUTED_TO_VOICE_URL.has(callStatus)) {
    return handleIncomingCallStatusCallback(req, res);
  }

  /**
   * Legacy: statusCallback === voice URL. After TwiML answered, Twilio may POST in-progress;
   * returning <Dial> again would be wrong.
   */
  if (callStatus === 'in-progress') {
    res.type('text/xml').status(200).send(EMPTY_TWIML);
    return;
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
    const dialTo = getReplaceNumberDialDestination(business);
    console.log('[call] Replace number mode: dialing destination phone');
    console.log('[call] TwiML: Dial to forward_to_phone (fallback owner_phone) with AMD enabled');
    res.type('text/xml').status(200).send(buildDialTwiml(dialTo));
    return;
  }

  console.log('[call] Forward mode: Reject forwarded leg; final status callback drives follow-up');
  res.type('text/xml').status(200).send(FORWARD_REJECT_TWIML);
}

export async function handleIncomingCallDialAction(req: Request, res: Response): Promise<void> {
  res.type('text/xml').status(200).send(EMPTY_TWIML);
}
