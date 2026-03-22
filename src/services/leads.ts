/**
 * Inserts a portal lead row when a missed call is captured (Twilio → service role, bypasses RLS).
 */
import { supabase } from '../lib/supabase';

export async function insertLeadForMissedCall(businessId: string, callerPhone: string): Promise<void> {
  const phone = callerPhone?.trim();
  if (!businessId || !phone) return;

  const { error } = await supabase.from('leads').insert({
    business_id: businessId,
    caller_phone: phone,
    status: 'new',
  });

  if (error) {
    console.error('[leads] insertLeadForMissedCall failed', error);
  }
}
