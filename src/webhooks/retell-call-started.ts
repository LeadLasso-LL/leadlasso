/**
 * POST /webhooks/retell-call-started
 * Retell inbound call / call_started — resolve business_name dynamic variable from to_number → juvo_number.
 */
import { Request, Response } from 'express';
import { verifyRetellWebhook } from '../lib/retell';
import { findBusinessForRetellCall } from '../services/business';

const FALLBACK_BUSINESS_NAME = 'our team';

type RetellCallStartedBody = {
  event?: string;
  call?: { to_number?: string };
  call_inbound?: { to_number?: string };
};

function asString(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function extractToNumber(payload: RetellCallStartedBody): string | null {
  return asString(payload.call_inbound?.to_number) ?? asString(payload.call?.to_number);
}

function buildDynamicVariablesResponse(businessName: string): Record<string, unknown> {
  return {
    call_inbound: {
      dynamic_variables: {
        business_name: businessName,
      },
    },
  };
}

export async function handleRetellCallStarted(req: Request, res: Response): Promise<void> {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'RETELL_API_KEY not configured' });
    return;
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: 'Invalid body' });
    return;
  }

  const rawBodyStr = rawBody.toString('utf-8');
  const signature = req.headers['x-retell-signature'] as string | undefined;
  if (!verifyRetellWebhook(rawBodyStr, apiKey, signature)) {
    console.error('[retell] call-started signature verification failed');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let payload: RetellCallStartedBody;
  try {
    payload = JSON.parse(rawBodyStr) as RetellCallStartedBody;
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const toNumber = extractToNumber(payload);
  let businessName = FALLBACK_BUSINESS_NAME;

  if (toNumber) {
    try {
      const business = await findBusinessForRetellCall(toNumber);
      if (business?.business_name?.trim()) {
        businessName = business.business_name.trim();
      } else if (!business) {
        console.warn('[retell] call-started no business for to_number', { to_number: toNumber });
      }
    } catch (err) {
      console.error('[retell] call-started business lookup failed', err);
    }
  } else {
    console.warn('[retell] call-started missing to_number', { event: payload.event });
  }

  console.log('[retell] call-started dynamic variable', { to_number: toNumber, business_name: businessName });

  // Retell inbound webhook expects dynamic_variables under call_inbound; also include top-level
  // business_name for callers that read a flat object.
  res.status(200).json({
    business_name: businessName,
    ...buildDynamicVariablesResponse(businessName),
  });
}
