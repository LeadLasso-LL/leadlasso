/**
 * Inserts / resolves portal lead rows for missed calls (Twilio → service role, bypasses RLS).
 * Idempotent per Twilio CallSid via unique source_twilio_call_sid.
 */
import { supabase } from '../lib/supabase';

const DUPLICATE_KEY = '23505';

export type MissedCallLeadRow = {
  id: string;
  auto_reply_sent_at: string | null;
  owner_missed_call_alert_sent_at: string | null;
};

/**
 * Ensures a lead row exists for this CallSid. On duplicate CallSid returns the existing row.
 */
export async function ensureMissedCallLead(
  businessId: string,
  callerPhone: string,
  twilioCallSid: string
): Promise<{ row: MissedCallLeadRow; inserted: boolean } | null> {
  const phone = callerPhone?.trim();
  const sid = twilioCallSid?.trim();
  if (!businessId || !phone || !sid) return null;

  const { data: created, error } = await supabase
    .from('leads')
    .insert({
      business_id: businessId,
      caller_phone: phone,
      status: 'new',
      source_twilio_call_sid: sid,
    })
    .select('id, auto_reply_sent_at, owner_missed_call_alert_sent_at')
    .single();

  if (!error && created) {
    return { row: created, inserted: true };
  }

  if (error?.code === DUPLICATE_KEY) {
    const { data: existing, error: fetchErr } = await supabase
      .from('leads')
      .select('id, auto_reply_sent_at, owner_missed_call_alert_sent_at')
      .eq('source_twilio_call_sid', sid)
      .maybeSingle();

    if (fetchErr || !existing) {
      console.error('[leads] failed to load lead after duplicate CallSid', fetchErr);
      return null;
    }
    return { row: existing, inserted: false };
  }

  console.error('[leads] ensureMissedCallLead insert failed', error);
  return null;
}

export async function markLeadAutoReplySent(leadId: string): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({ auto_reply_sent_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) console.error('[leads] markLeadAutoReplySent failed', error);
}

export async function markLeadOwnerMissedCallAlertSent(leadId: string): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({ owner_missed_call_alert_sent_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) console.error('[leads] markLeadOwnerMissedCallAlertSent failed', error);
}
