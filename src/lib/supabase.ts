/**
 * Supabase client and shared types for LeadLasso.
 * Uses service role key so the backend can read/write all tables.
 * No auth layer in this scaffold; webhooks are public endpoints.
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

// --- Row types (snake_case to match Supabase columns) ---

export type SetupType = 'forwarding' | 'replace_number';
export type PlanStatus = 'active' | 'inactive';
export type ConversationStatus = 'active' | 'closed';

export interface BusinessRow {
  id: string;
  email: string | null;
  /** Linked auth user for customer portal (Supabase Auth). */
  user_id: string | null;
  business_name: string;
  sender_name: string | null;
  owner_phone: string;
  forward_to_phone: string | null;
  leadlasso_number: string | null;
  auto_reply_template: string | null;
  setup_type: SetupType;
  plan_status: PlanStatus;
  stripe_customer_id: string | null;
  /** Set when created from checkout.session.completed — used by GET /onboarding/success */
  stripe_checkout_session_id: string | null;
  preferred_area_code: string | null;
  /** Owner SMS when immediate missed-call lead alert is triggered */
  owner_new_lead_alerts_enabled: boolean;
  /** Owner SMS when customer texts the LeadLasso number (forwarded to owner_phone) */
  owner_customer_reply_alerts_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  business_id: string;
  customer_phone: string;
  owner_phone: string;
  leadlasso_number: string;
  status: ConversationStatus;
  conversation_code: string | null;
  requires_owner_reply_intro_on_next_sms?: boolean;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutboundCustomerSmsRow {
  id: string;
  customer_phone: string;
  created_at: string;
}

export interface LeadRow {
  id: string;
  business_id: string;
  caller_phone: string;
  status: 'new' | 'booked';
  created_at: string;
  booked_at: string | null;
  source_twilio_call_sid?: string | null;
  auto_reply_sent_at?: string | null;
  owner_missed_call_alert_sent_at?: string | null;
}
