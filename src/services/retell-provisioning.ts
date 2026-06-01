/**
 * Purchase a US phone number from Retell and bind inbound/outbound agents.
 */
const RETELL_API_BASE = 'https://api.retellai.com';

export type PurchaseRetellNumberParams = {
  areaCode: number;
  agentId: string;
};

export type PurchaseRetellNumberResult = {
  phoneNumber: string;
  phoneNumberPretty: string | null;
};

function parseRetellPhoneResponse(data: unknown): PurchaseRetellNumberResult | null {
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  const phone =
    (typeof row.phone_number === 'string' && row.phone_number) ||
    (typeof row.phoneNumber === 'string' && row.phoneNumber) ||
    '';
  if (!phone) return null;
  const pretty =
    (typeof row.phone_number_pretty === 'string' && row.phone_number_pretty) ||
    (typeof row.phoneNumberPretty === 'string' && row.phoneNumberPretty) ||
    null;
  return { phoneNumber: phone, phoneNumberPretty: pretty };
}

/**
 * Tries documented create-phone-number first, then v2 purchase path from product spec.
 */
export async function purchaseRetellPhoneNumber(
  params: PurchaseRetellNumberParams
): Promise<PurchaseRetellNumberResult> {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('RETELL_API_KEY not configured');
  }

  const body = {
    area_code: params.areaCode,
    country_code: 'US',
    number_provider: 'twilio',
    inbound_agents: [{ agent_id: params.agentId, weight: 1 }],
    outbound_agents: [{ agent_id: params.agentId, weight: 1 }],
    inbound_agent_id: params.agentId,
    outbound_agent_id: params.agentId,
  };

  const endpoints = ['/create-phone-number', '/v2/phone-numbers/purchase'];
  let lastError = 'Retell phone purchase failed';

  for (const path of endpoints) {
    const res = await fetch(`${RETELL_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: unknown = await res.json().catch(() => ({}));
    if (res.ok) {
      const parsed = parseRetellPhoneResponse(data);
      if (parsed) {
        console.log('[retell] phone purchased', { path, phone: parsed.phoneNumber });
        return parsed;
      }
      lastError = 'Retell returned an unexpected response';
      continue;
    }

    const message =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message?: string }).message)
        : res.statusText;
    lastError = message || lastError;
    if (res.status === 404) continue;
    console.error('[retell] phone purchase failed', { path, status: res.status, message });
  }

  throw new Error(lastError);
}
