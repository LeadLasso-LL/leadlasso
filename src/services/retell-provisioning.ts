/**
 * Purchase a US phone number from Retell and bind inbound/outbound agents.
 * @see https://docs.retellai.com/api-references/update-phone-number
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

function retellErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'message' in data) {
    const msg = (data as { message?: string }).message;
    if (msg) return String(msg);
  }
  return fallback;
}

function formatAreaCode(areaCode: number): string {
  const digits = String(areaCode).replace(/\D/g, '').slice(0, 3);
  if (digits.length !== 3) {
    throw new Error('area_code must be a valid 3-digit US area code');
  }
  return digits;
}

async function bindRetellPhoneAgents(
  apiKey: string,
  phoneNumber: string,
  agentId: string
): Promise<void> {
  const encoded = encodeURIComponent(phoneNumber);
  const res = await fetch(`${RETELL_API_BASE}/update-phone-number/${encoded}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inbound_agents: [{ agent_id: agentId, weight: 1 }],
      outbound_agents: [{ agent_id: agentId, weight: 1 }],
    }),
  });

  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = retellErrorMessage(data, res.statusText) || 'Retell agent bind failed';
    console.error('[retell] phone agent bind failed', { status: res.status, message });
    throw new Error(message);
  }
}

/**
 * POST /purchase-phone-number with { area_code: "813" }, then bind agents on the number.
 */
export async function purchaseRetellPhoneNumber(
  params: PurchaseRetellNumberParams
): Promise<PurchaseRetellNumberResult> {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('RETELL_API_KEY not configured');
  }

  const area_code = formatAreaCode(params.areaCode);

  const res = await fetch(`${RETELL_API_BASE}/purchase-phone-number`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ area_code }),
  });

  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = retellErrorMessage(data, res.statusText) || 'Retell phone purchase failed';
    console.error('[retell] phone purchase failed', { status: res.status, message });
    throw new Error(message);
  }

  const parsed = parseRetellPhoneResponse(data);
  if (!parsed) {
    throw new Error('Retell returned an unexpected response');
  }

  console.log('[retell] phone purchased', { phone: parsed.phoneNumber, area_code });

  await bindRetellPhoneAgents(apiKey, parsed.phoneNumber, params.agentId);

  return parsed;
}
