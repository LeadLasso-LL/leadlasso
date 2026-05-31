/**
 * Outbound SMS to business owners (new-lead alerts).
 */
import { twilioClient } from '../lib/twilio';
import type { BusinessRow } from '../lib/supabase';

export async function sendOwnerNewLeadSms(business: BusinessRow, body: string): Promise<void> {
  const from = business.juvo_number?.trim();
  const to = business.owner_phone?.trim();
  if (!from || !to) {
    console.warn('[sms] skip owner alert — missing juvo_number or owner_phone', business.id);
    return;
  }

  await twilioClient.messages.create({ from, to, body });
}
