/**
 * Owner-facing SMS notification preferences (businesses row).
 * Default ON when missing (backward compatibility / safe fallback).
 */
import type { BusinessRow } from '../lib/supabase';

export function isOwnerNewLeadAlertsEnabled(business: BusinessRow): boolean {
  const v = business.owner_new_lead_alerts_enabled;
  return v !== false;
}

export function isOwnerCustomerReplyAlertsEnabled(business: BusinessRow): boolean {
  const v = business.owner_customer_reply_alerts_enabled;
  return v !== false;
}
