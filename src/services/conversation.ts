/**
 * Conversation lookup and update.
 * One conversation per (business, customer_phone). Used to:
 * - Store state when a customer messages (find or create, then update last_message_at).
 * - Route owner replies: most recent active conversation for that business (or that owner).
 */
import { supabase } from '../lib/supabase';
import type { BusinessRow, ConversationRow } from '../lib/supabase';

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && !phone.startsWith('+')) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/**
 * Result of findOrCreateConversation: the conversation row and whether it was newly created.
 */
export type FindOrCreateResult = { conversation: ConversationRow; created: boolean };

/**
 * Find or create a conversation for this business and customer.
 * Updates last_message_at and updated_at so "most recent" ordering works.
 * Requires business to have leadlasso_number set.
 */
export async function findOrCreateConversation(
  business: BusinessRow,
  customerPhone: string
): Promise<FindOrCreateResult> {
  const customerE164 = toE164(customerPhone);
  const leadlasso = business.leadlasso_number;
  if (!leadlasso) throw new Error('Business has no leadlasso_number');

  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('business_id', business.id)
    .eq('customer_phone', customerE164)
    .maybeSingle();

  if (existing) {
    const updates: Record<string, unknown> = {
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (!(existing as ConversationRow).conversation_code) {
      updates.conversation_code = await generateUniqueConversationCode();
    }
    const { data: updated, error } = await supabase
      .from('conversations')
      .update(updates)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return { conversation: updated as ConversationRow, created: false };
  }

  const conversation_code = await generateUniqueConversationCode();
  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      business_id: business.id,
      customer_phone: customerE164,
      owner_phone: business.owner_phone,
      leadlasso_number: leadlasso,
      status: 'active',
      conversation_code,
      requires_owner_reply_intro_on_next_sms: false,
      last_message_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return { conversation: created as ConversationRow, created: true };
}

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomFourCharCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/**
 * Generate a unique 4-character uppercase alphanumeric code for active conversations.
 * Retries on collision.
 */
export async function generateUniqueConversationCode(): Promise<string> {
  const maxAttempts = 50;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = randomFourCharCode();
    const { data, error } = await supabase
      .from('conversations')
      .select('id')
      .eq('conversation_code', code)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return code;
  }
  throw new Error('Could not generate unique conversation code');
}

/**
 * Find active conversation for this owner with the given 4-character conversation_code.
 */
/**
 * Prepare (or update) the conversation row for a missed call so the same conversation_code
 * is used for the immediate owner alert and for later customer SMS routing.
 * Sets requires_owner_reply_intro_on_next_sms so the first customer SMS still sends the full owner intro.
 */
export async function prepareConversationForMissedCall(
  business: BusinessRow,
  customerPhone: string
): Promise<{ code: string } | null> {
  const customerE164 = toE164(customerPhone);
  const leadlasso = business.leadlasso_number;
  if (!leadlasso) return null;

  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('business_id', business.id)
    .eq('customer_phone', customerE164)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing) {
    let code = (existing as ConversationRow).conversation_code;
    if (!code) {
      code = await generateUniqueConversationCode();
    }
    const { error } = await supabase
      .from('conversations')
      .update({
        conversation_code: code,
        requires_owner_reply_intro_on_next_sms: true,
        last_message_at: now,
        updated_at: now,
      })
      .eq('id', existing.id);
    if (error) throw error;
    return { code };
  }

  const conversation_code = await generateUniqueConversationCode();
  const { error: insertError } = await supabase.from('conversations').insert({
    business_id: business.id,
    customer_phone: customerE164,
    owner_phone: toE164(business.owner_phone),
    leadlasso_number: leadlasso,
    status: 'active',
    conversation_code,
    requires_owner_reply_intro_on_next_sms: true,
    last_message_at: now,
  });
  if (insertError) throw insertError;
  return { code: conversation_code };
}

/** Conversation code for customer + business (e.g. retry owner alert after missed call). */
export async function getConversationCodeForBusinessCustomer(
  businessId: string,
  customerPhone: string
): Promise<string | null> {
  const customerE164 = toE164(customerPhone);
  const { data, error } = await supabase
    .from('conversations')
    .select('conversation_code')
    .eq('business_id', businessId)
    .eq('customer_phone', customerE164)
    .maybeSingle();
  if (error) throw error;
  const code = (data as { conversation_code: string | null } | null)?.conversation_code;
  return code && code.length === 4 ? code : null;
}

export async function clearRequiresOwnerReplyIntro(conversationId: string): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({
      requires_owner_reply_intro_on_next_sms: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (error) throw error;
}

export async function getConversationByOwnerAndCode(
  ownerPhone: string,
  code: string
): Promise<ConversationRow | null> {
  const conversationCodeExact = (code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);

  if (conversationCodeExact.length !== 4) return null;

  const ownerPhoneNormalized = toE164(ownerPhone);

  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('owner_phone', ownerPhoneNormalized)
    .eq('conversation_code', conversationCodeExact)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as ConversationRow | null;
}


/**
 * Update last_message_at and updated_at for a conversation (e.g. when owner or customer sends a message).
 */
export async function updateConversationTimestamps(conversationId: string): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (error) throw error;
}

/**
 * Most recent active conversation for this business (by last_message_at).
 * Used when owner replies to the LeadLasso number: we send their message to this customer.
 */
export async function getMostRecentActiveConversationForBusiness(
  businessId: string
): Promise<ConversationRow | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('business_id', businessId)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as ConversationRow | null;
}

/**
 * Most recent active conversation where owner_phone matches (for owner-reply webhook).
 * Used when the request is keyed by owner From number instead of LeadLasso To.
 */
export async function getMostRecentActiveConversationForOwner(
  ownerPhone: string
): Promise<ConversationRow | null> {
  const normalized = toE164(ownerPhone);
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('owner_phone', normalized)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as ConversationRow | null;
}
