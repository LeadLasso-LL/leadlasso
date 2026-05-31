/**
 * Business lookup by the Juvo number that received the event.
 */
import { supabase } from '../lib/supabase';
import type { BusinessRow, PlanStatus } from '../lib/supabase';

const ACTIVE: PlanStatus = 'active';

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && !phone.startsWith('+')) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/** Find the business that owns this Juvo number. */
export async function findBusinessByJuvoNumber(toNumber: string): Promise<BusinessRow | null> {
  const normalized = normalizePhone(toNumber);
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('juvo_number', normalized)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function isBusinessActive(business: BusinessRow): boolean {
  return business.plan_status === ACTIVE;
}
