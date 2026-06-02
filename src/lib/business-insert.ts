/**
 * businesses insert shape — must match supabase/migrations (001–015).
 * Dropped columns (do not insert): sender_name, auto_reply_template, forward_to_phone, leadlasso_number.
 */
import type { BusinessHours, CallMode, PlanStatus, SetupType } from './supabase';

export type BusinessInsertRow = {
  email?: string | null;
  user_id?: string | null;
  business_name: string;
  first_name?: string | null;
  owner_phone: string;
  existing_number?: string | null;
  juvo_number?: string | null;
  retell_agent_id?: string | null;
  industry?: string | null;
  call_mode?: CallMode | null;
  business_hours?: BusinessHours | null;
  sms_opt_in?: boolean | null;
  setup_type: SetupType;
  plan_status?: PlanStatus;
  preferred_area_code?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_checkout_session_id?: string | null;
  owner_new_lead_alerts_enabled?: boolean;
  owner_customer_reply_alerts_enabled?: boolean;
};

/** Strip undefined keys so Supabase client does not send spurious columns. */
export function toBusinessInsertRow(row: BusinessInsertRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
