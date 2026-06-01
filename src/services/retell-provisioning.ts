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

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function redactAuthorization(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  if (out.Authorization) {
    out.Authorization = out.Authorization.startsWith('Bearer ')
      ? 'Bearer [REDACTED]'
      : '[REDACTED]';
  }
  return out;
}

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
 * Buy a number via POST /create-phone-number (Retell docs).
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

  const url = `${RETELL_API_BASE}/create-phone-number`;
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const requestBodyRaw = JSON.stringify(body);

  console.log('[retell] create-phone-number request', {
    url,
    method: 'POST',
    headers: redactAuthorization(requestHeaders),
    body,
    bodyRaw: requestBodyRaw,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: requestBodyRaw,
  });

  const responseHeaders = headersToRecord(res.headers);
  const responseBodyRaw = await res.text();

  console.log('[retell] create-phone-number response', {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
    body: responseBodyRaw,
  });

  let data: unknown = {};
  if (responseBodyRaw) {
    try {
      data = JSON.parse(responseBodyRaw) as unknown;
    } catch {
      data = { _parseError: true, _raw: responseBodyRaw };
    }
  }

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message?: string }).message)
        : res.statusText;
    console.error('[retell] phone purchase failed', { status: res.status, message });
    throw new Error(message || 'Retell phone purchase failed');
  }

  const parsed = parseRetellPhoneResponse(data);
  if (!parsed) {
    throw new Error('Retell returned an unexpected response');
  }

  console.log('[retell] phone purchased', { phone: parsed.phoneNumber });
  return parsed;
}
