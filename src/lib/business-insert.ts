/**
 * businesses insert shape — columns verified against live public.businesses (PostgREST).
 * Excludes id, created_at, updated_at (DB defaults). Not insertable: preferred_area_code,
 * owner_customer_reply_alerts_enabled, forward_to_phone, sender_name, auto_reply_template, leadlasso_number.
 */
import type { BusinessHours, CallMode, PlanStatus, SetupType } from './supabase';

/** Columns that exist on public.businesses and may be set on insert. */
export const BUSINESS_INSERT_COLUMNS = [
  'email',
  'user_id',
  'business_name',
  'first_name',
  'owner_phone',
  'existing_number',
  'juvo_number',
  'retell_agent_id',
  'industry',
  'call_mode',
  'business_hours',
  'sms_opt_in',
  'setup_type',
  'plan_status',
  'stripe_customer_id',
  'stripe_subscription_id',
  'stripe_checkout_session_id',
  'owner_new_lead_alerts_enabled',
] as const;

export type BusinessInsertColumn = (typeof BUSINESS_INSERT_COLUMNS)[number];

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
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_checkout_session_id?: string | null;
  owner_new_lead_alerts_enabled?: boolean;
};

const INSERT_COLUMN_SET = new Set<string>(BUSINESS_INSERT_COLUMNS);

/** Only passes through keys that exist on the live businesses table. */
export function toBusinessInsertRow(row: BusinessInsertRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of BUSINESS_INSERT_COLUMNS) {
    const value = row[key as keyof BusinessInsertRow];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
