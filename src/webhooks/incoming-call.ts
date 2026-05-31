/**
 * POST /webhooks/incoming-call
 *
 * Twilio voice URL: route replace_number calls to forward_to_phone; forwarding mode rejects leg.
 * Missed-call lead rows are created from the final status callback only.
 */
import { Request, Response } from 'express';
import type { BusinessRow } from '../lib/supabase';
import { findBusinessByJuvoNumber, isBusinessActive } from '../services/business';
import { ensureCallLead } from '../services/leads';
import {
  evaluateMissedCallFollowUp,
  isTerminalCallStatus,
  parseCallDurationSeconds,
} from '../services/call-outcome';

const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const FORWARD_REJECT_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';

const STATUS_ROUTED_TO_VOICE_URL = new Set([
  'completed',
  'no-answer',
  'busy',
  'failed',
  'canceled',
]);

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && !phone.startsWith('+')) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

function buildDialTwiml(dialDestination: string): string {
  const num = escapeXmlText(normalizePhone(dialDestination));
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20"><Number machineDetection="Enable">${num}</Number></Dial></Response>`;
}

function getReplaceNumberDialDestination(business: BusinessRow): string {
  const ft = business.forward_to_phone?.trim();
  if (ft) return normalizePhone(ft);
  return normalizePhone(business.owner_phone);
}

export async function handleIncomingCallStatusCallback(req: Request, res: Response): Promise<void> {
  const callSid = String(req.body.CallSid ?? '').trim();
  const callStatus = String(req.body.CallStatus ?? '').trim().toLowerCase();
  const from = req.body.From as string;
  const to = req.body.To as string;
  const durationSec = parseCallDurationSeconds(req.body.CallDuration);
  const answeredByRaw = req.body.AnsweredBy;
  const answeredBy =
    answeredByRaw != null && String(answeredByRaw).trim() !== '' ? String(answeredByRaw).trim() : undefined;

  if (!isTerminalCallStatus(callStatus)) {
    res.status(200).end();
    return;
  }

  const evaluation = evaluateMissedCallFollowUp({
    callStatus,
    callDurationSeconds: durationSec,
    answeredBy,
  });

  if (evaluation.action !== 'follow-up') {
    res.status(200).end();
    return;
  }

  if (!callSid || !from || !to) {
    res.status(200).end();
    return;
  }

  const business = await findBusinessByJuvoNumber(to);
  if (!business || !isBusinessActive(business) || !business.juvo_number) {
    res.status(200).end();
    return;
  }

  const fromNormalized = normalizePhone(from);
  const ownerNormalized = normalizePhone(business.owner_phone);
  const dialDestNormalized =
    business.setup_type === 'replace_number' ? getReplaceNumberDialDestination(business) : null;
  if (
    fromNormalized === ownerNormalized ||
    (dialDestNormalized != null && fromNormalized === dialDestNormalized)
  ) {
    res.status(200).end();
    return;
  }

  const leadResult = await ensureCallLead({
    businessId: business.id,
    callerNumber: from,
    callId: callSid,
  });

  if (leadResult?.inserted) {
    console.log('[call] lead created', { callSid, businessId: business.id });
  }

  res.status(200).end();
}

export async function handleIncomingCall(req: Request, res: Response): Promise<void> {
  const callStatusRaw = req.body.CallStatus as string | undefined;
  const callStatus = callStatusRaw?.trim().toLowerCase() ?? '';

  if (callStatusRaw && STATUS_ROUTED_TO_VOICE_URL.has(callStatus)) {
    return handleIncomingCallStatusCallback(req, res);
  }

  if (callStatus === 'in-progress') {
    res.type('text/xml').status(200).send(EMPTY_TWIML);
    return;
  }

  const to = req.body.To as string;
  const business = await findBusinessByJuvoNumber(to);
  if (!business || !isBusinessActive(business) || !business.juvo_number) {
    res.type('text/xml').status(200).send(EMPTY_TWIML);
    return;
  }

  if (business.setup_type === 'replace_number') {
    res.type('text/xml').status(200).send(buildDialTwiml(getReplaceNumberDialDestination(business)));
    return;
  }

  res.type('text/xml').status(200).send(FORWARD_REJECT_TWIML);
}

export async function handleIncomingCallDialAction(_req: Request, res: Response): Promise<void> {
  res.type('text/xml').status(200).send(EMPTY_TWIML);
}
