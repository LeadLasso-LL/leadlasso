/**
 * Voice leads captured from calls (Retell / Twilio → service role, bypasses RLS).
 * Idempotent per call_id when provided.
 */
import { supabase } from '../lib/supabase';
import type { LeadRow } from '../lib/supabase';

const DUPLICATE_KEY = '23505';

export type EnsureCallLeadInput = {
  businessId: string;
  callerNumber: string;
  callId: string;
  callerName?: string | null;
  jobDescription?: string | null;
  recordingUrl?: string | null;
  transcript?: string | null;
};

/**
 * Ensures a lead row exists for this call. On duplicate call_id returns the existing row.
 */
export async function ensureCallLead(
  input: EnsureCallLeadInput
): Promise<{ row: LeadRow; inserted: boolean } | null> {
  const phone = input.callerNumber?.trim();
  const callId = input.callId?.trim();
  if (!input.businessId || !phone || !callId) return null;

  const { data: created, error } = await supabase
    .from('leads')
    .insert({
      business_id: input.businessId,
      caller_number: phone,
      call_id: callId,
      caller_name: input.callerName?.trim() || null,
      job_description: input.jobDescription?.trim() || null,
      recording_url: input.recordingUrl?.trim() || null,
      transcript: input.transcript?.trim() || null,
      status: 'new',
    })
    .select('*')
    .single();

  if (!error && created) {
    return { row: created, inserted: true };
  }

  if (error?.code === DUPLICATE_KEY) {
    const { data: existing, error: fetchErr } = await supabase
      .from('leads')
      .select('*')
      .eq('call_id', callId)
      .maybeSingle();

    if (fetchErr || !existing) {
      console.error('[leads] failed to load lead after duplicate call_id', fetchErr);
      return null;
    }
    return { row: existing, inserted: false };
  }

  console.error('[leads] ensureCallLead insert failed', error);
  return null;
}

export async function upsertLeadFromRetellWebhook(input: EnsureCallLeadInput): Promise<LeadRow | null> {
  const result = await ensureCallLead(input);
  return result?.row ?? null;
}
