/**
 * POST /webhooks/retell-call-ended
 * Retell AI call_ended / call_analyzed — capture lead and notify business owner.
 */
import { Request, Response } from 'express';
import { verifyRetellWebhook } from '../lib/retell';
import { findBusinessForRetellCall } from '../services/business';
import { upsertLeadFromRetellWebhook } from '../services/leads';
import { sendOwnerNewLeadSms } from '../services/sms';

type RetellCallPayload = {
  call_id?: string;
  agent_id?: string;
  from_number?: string;
  to_number?: string;
  recording_url?: string;
  transcript?: string;
  call_analysis?: {
    custom_analysis_data?: Record<string, unknown>;
  };
  retell_llm_dynamic_variables?: Record<string, unknown>;
  collect_dynamic_variables?: Record<string, unknown>;
};

type RetellWebhookBody = {
  event?: string;
  call?: RetellCallPayload;
};

const HANDLED_EVENTS = new Set(['call_ended', 'call_analyzed']);

function asString(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function pickAnalysisField(
  call: RetellCallPayload,
  key: string
): string | null {
  const custom = call.call_analysis?.custom_analysis_data?.[key];
  if (custom != null) return asString(custom);

  const llm = call.retell_llm_dynamic_variables?.[key];
  if (llm != null) return asString(llm);

  const collected = call.collect_dynamic_variables?.[key];
  if (collected != null) return asString(collected);

  return null;
}

function formatOwnerAlertMessage(
  callerName: string | null,
  jobDescription: string | null,
  callerNumber: string
): string {
  const name = callerName || 'Someone';
  const job = jobDescription || 'their inquiry';
  return `New Juvo lead: ${name} called about ${job}. Call them back at ${callerNumber}.`;
}

export async function handleRetellCallEnded(req: Request, res: Response): Promise<void> {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    res.status(500).send('RETELL_API_KEY not configured');
    return;
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).send('Invalid body');
    return;
  }

  const rawBodyStr = rawBody.toString('utf-8');
  const signature = req.headers['x-retell-signature'] as string | undefined;
  if (!verifyRetellWebhook(rawBodyStr, apiKey, signature)) {
    console.error('[retell] webhook signature verification failed');
    res.status(401).send('Unauthorized');
    return;
  }

  let payload: RetellWebhookBody;
  try {
    payload = JSON.parse(rawBodyStr) as RetellWebhookBody;
  } catch {
    res.status(400).send('Invalid JSON');
    return;
  }

  const event = payload.event;
  if (!event || !HANDLED_EVENTS.has(event)) {
    res.status(200).send();
    return;
  }

  const call = payload.call;
  if (!call) {
    console.error('[retell] missing call object', event);
    res.status(200).send();
    return;
  }

  const callId = asString(call.call_id);
  const fromNumber = asString(call.from_number);
  const toNumber = asString(call.to_number);
  if (!callId || !fromNumber) {
    console.error('[retell] missing call_id or from_number', { callId, fromNumber });
    res.status(200).send();
    return;
  }

  if (!toNumber) {
    console.error('[retell] missing to_number — cannot match business', { callId });
    res.status(200).send();
    return;
  }

  const business = await findBusinessForRetellCall(toNumber);
  if (!business) {
    console.error('[retell] no business for to_number → juvo_number', { to_number: toNumber });
    res.status(200).send();
    return;
  }

  const callerName = pickAnalysisField(call, 'caller_name');
  const callerNumber = pickAnalysisField(call, 'caller_number') ?? fromNumber;
  const jobDescription = pickAnalysisField(call, 'job_description');

  const leadResult = await upsertLeadFromRetellWebhook({
    businessId: business.id,
    callId,
    callerNumber,
    callerName,
    jobDescription,
    recordingUrl: asString(call.recording_url),
    transcript: asString(call.transcript),
  });

  if (!leadResult) {
    console.error('[retell] failed to upsert lead', callId);
    res.status(500).send('Failed to save lead');
    return;
  }

  if (
    leadResult.inserted &&
    business.owner_new_lead_alerts_enabled &&
    business.owner_phone?.trim()
  ) {
    try {
      await sendOwnerNewLeadSms(
        business,
        formatOwnerAlertMessage(callerName, jobDescription, callerNumber)
      );
    } catch (err) {
      console.error('[retell] owner SMS failed', err);
    }
  }

  res.status(200).send();
}
