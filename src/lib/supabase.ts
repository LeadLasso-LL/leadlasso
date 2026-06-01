/**
 * Supabase client and shared types for Juvo.
 * Uses service role key so the backend can read/write all tables.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

export const supabase: SupabaseClient = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

export type SetupType = 'forwarding' | 'replace_number';
export type CallMode = 'ai_first' | 'human_first';
export type PlanStatus = 'active' | 'inactive';
export type OnboardingPlan = 'starter' | 'pro';

export interface BusinessHoursDay {
  open: boolean;
  openTime?: string;
  closeTime?: string;
}

export type BusinessHours = Record<string, BusinessHoursDay>;

export interface BusinessRow {
  id: string;
  email: string | null;
  user_id: string | null;
  business_name: string;
  first_name: string | null;
  owner_phone: string;
  existing_number: string | null;
  juvo_number: string | null;
  retell_agent_id: string | null;
  industry: string | null;
  call_mode: CallMode | null;
  business_hours: BusinessHours | null;
  sms_opt_in: boolean | null;
  setup_type: SetupType;
  plan_status: PlanStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  preferred_area_code: string | null;
  owner_new_lead_alerts_enabled: boolean;
  owner_customer_reply_alerts_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface LeadRow {
  id: string;
  business_id: string;
  caller_name: string | null;
  caller_number: string;
  job_description: string | null;
  call_id: string | null;
  recording_url: string | null;
  transcript: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}
