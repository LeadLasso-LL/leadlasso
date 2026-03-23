import { supabase } from '../lib/supabase';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageSenderType = 'customer' | 'owner' | 'system';

export async function persistConversationMessage(params: {
  conversationId: string;
  businessId: string;
  customerPhone: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  body: string;
  channel?: 'sms';
}): Promise<void> {
  const body = params.body.trim();
  if (!body) return;

  const { error } = await supabase.from('conversation_messages').insert({
    conversation_id: params.conversationId,
    business_id: params.businessId,
    customer_phone: params.customerPhone,
    direction: params.direction,
    sender_type: params.senderType,
    body,
    channel: params.channel ?? 'sms',
  });

  if (error) {
    console.error('[messages] persist failed', {
      conversationId: params.conversationId,
      direction: params.direction,
      senderType: params.senderType,
      error,
    });
  }
}

