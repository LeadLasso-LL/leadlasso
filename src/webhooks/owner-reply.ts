/**
 * POST /webhooks/owner-reply
 *
 * Alternative entry for owner reply (e.g. if owner replies via another channel that POSTs here).
 * Identify owner by From; find most recent active conversation for that owner; send message to customer.
 *
 * Logic (skeleton — full behavior in later phase):
 * 1. From = owner phone, Body = message. Find most recent active conversation where owner_phone = From.
 * 2. If no conversation or business inactive → 200 no body.
 * 3. Else: update conversation timestamps, send Body to conversation.customer_phone from conversation.leadlasso_number.
 */
import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { isBusinessActive } from '../services/business';
import {
  getConversationByOwnerAndCode,
  updateConversationTimestamps,
} from '../services/conversation';
import { sendCustomerSms, sendSms } from '../services/sms';

export async function handleOwnerReply(req: Request, res: Response): Promise<void> {
  try {
    const from = req.body.From as string;
    const body = (req.body.Body || '').trim();

    if (!from || !body) {
      res.status(200).end();
      return;
    }

    const codeMatch = body.match(/^([A-Z0-9]{4})(?:\s|$)/i);
    const code = codeMatch ? codeMatch[1].toUpperCase() : null;
    const conversation = code ? await getConversationByOwnerAndCode(from, code) : null;
    if (!conversation) {
      res.status(200).end();
      return;
    }
    const bodyWithoutCode = codeMatch ? body.slice(codeMatch[0].length).trim() : '';
    if (!bodyWithoutCode) {
      res.status(200).end();
      return;
    }

    const { data: business } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', conversation.business_id)
      .single();

    if (!business || !isBusinessActive(business) || !business.leadlasso_number) {
      res.status(200).end();
      return;
    }

    await updateConversationTimestamps(conversation.id);
    await sendCustomerSms({
      from: business.leadlasso_number,
      to: conversation.customer_phone,
      body: bodyWithoutCode,
      messageMeta: {
        conversationId: conversation.id,
        businessId: conversation.business_id,
        senderType: 'owner',
      },
    });

    res.status(200).end();
  } catch (err) {
    console.error('[owner-reply] Handler error', err);
    if (!res.headersSent) {
      res.status(200).end();
    }
  }
}
