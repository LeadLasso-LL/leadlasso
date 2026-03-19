/**
 * Business lookup by the LeadLasso number that received the event.
 * One lookup path for all webhooks: identify business by To (leadlasso_number).
 * No per-business flows; same logic for every business.
 */
import { supabase } from '../lib/supabase';
import type { BusinessRow, PlanStatus } from '../lib/supabase';

const ACTIVE: PlanStatus = 'active';

/** Normalize to E.164 for consistent lookup (Twilio sends +1...). */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && !phone.startsWith('+')) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/**
 * Find the business that owns this LeadLasso number (the number that received the call/SMS).
 * Returns null if no business has this number — webhook should then ignore or reject.
 */
export async function findBusinessByLeadlassoNumber(
  toNumber: string
): Promise<BusinessRow | null> {
  const normalized = normalizePhone(toNumber);
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('leadlasso_number', normalized)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Whether this business is allowed to receive and send messages (plan active). */
export function isBusinessActive(business: BusinessRow): boolean {
  return business.plan_status === ACTIVE;
}
