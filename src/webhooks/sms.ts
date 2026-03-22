/**
 * POST /webhooks/incoming-sms
 *
 * All SMS to a LeadLasso number hits this endpoint. We identify the business by To (that number).
 * Normal flow: customer replied to our auto-reply, or owner replied to our forward — we decide by From.
 *
 * Logic (skeleton — full behavior in later phase):
 * 1. Identify business by To. If none or inactive or no leadlasso_number → ignore (empty 200).
 * 2. If From === owner_phone: owner is replying → find most recent active conversation for this business,
 *    send owner's message to that customer from LeadLasso number, update conversation timestamps.
 * 3. Else: customer is messaging → find or create conversation, forward message to owner_phone,
 *    preserve conversation mapping for future owner replies.
 *
 * We do not assume customers text first; typically the first event was a call, then auto-reply, then customer reply.
 */
import { Request, Response } from 'express';
import { findBusinessByLeadlassoNumber, isBusinessActive } from '../services/business';
import {
  findOrCreateConversation,
  getConversationByOwnerAndCode,
  updateConversationTimestamps,
  clearRequiresOwnerReplyIntro,
} from '../services/conversation';
import { sendCustomerSms, sendSms } from '../services/sms';
import { isOwnerCustomerReplyAlertsEnabled } from '../services/owner-alerts';

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && !phone.startsWith('+')) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

const EMPTY_RESPONSE =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function handleIncomingSms(req: Request, res: Response): Promise<void> {
  try {
    console.log('[sms] Webhook received');
    const to = req.body.To as string;
    const from = req.body.From as string;
    const body = (req.body.Body || '').trim();
    console.log('[sms] From:', from);
    console.log('[sms] To:', to);
    console.log('[sms] Body:', body);

    const business = await findBusinessByLeadlassoNumber(to);
    console.log('[sms] Business found:', !!business);
    if (!business) {
      res.type('text/xml').status(200).send(EMPTY_RESPONSE);
      return;
    }
    if (!isBusinessActive(business) || !business.leadlasso_number) {
      res.type('text/xml').status(200).send(EMPTY_RESPONSE);
      return;
    }

    const fromNormalized = normalizePhone(from);
    const ownerNormalized = normalizePhone(business.owner_phone);
    const isOwner = fromNormalized === ownerNormalized;
    console.log('[sms] Sender treated as:', isOwner ? 'owner' : 'customer');

    // Owner replying: must start with valid 4-char code; route to that conversation.
    if (isOwner) {
      const codeMatch = body.match(/^([A-Z0-9]{4})(?:\s|$)/i);
      const code = codeMatch ? codeMatch[1].toUpperCase() : null;
      const conversation = code
        ? await getConversationByOwnerAndCode(business.owner_phone, code)
        : null;
      if (!conversation) {
        res.type('text/xml').status(200).send(EMPTY_RESPONSE);
        return;
      }
      const bodyWithoutCode = codeMatch ? body.slice(codeMatch[0].length).trim() : '';
      if (!bodyWithoutCode) {
        res.type('text/xml').status(200).send(EMPTY_RESPONSE);
        return;
      }
      await updateConversationTimestamps(conversation.id);
      await sendCustomerSms({
        from: business.leadlasso_number!,
        to: conversation.customer_phone,
        body: bodyWithoutCode,
      });
      res.type('text/xml').status(200).send(EMPTY_RESPONSE);
      return;
    }

    // Customer messaging: find or create conversation, forward to owner with 4-char code.
    const { conversation, created } = await findOrCreateConversation(business, from);
    console.log('[sms] Conversation found or created');
    const code = conversation.conversation_code ?? '';
    const primedFromMissedCall = conversation.requires_owner_reply_intro_on_next_sms === true;
    if (primedFromMissedCall) {
      await clearRequiresOwnerReplyIntro(conversation.id);
    }
    const sendFullOwnerIntro = created || primedFromMissedCall;
    const messageToOwner = sendFullOwnerIntro
      ? `New missed call lead ${code}\nFrom: ${from}\n\n${body}\n\nReply with ${code} at the start of your message to respond.`
      : `${code} ${body}`;
    if (isOwnerCustomerReplyAlertsEnabled(business)) {
      await sendSms({
        from: business.leadlasso_number!,
        to: business.owner_phone,
        body: messageToOwner,
      });
    } else {
      console.log('[owner alerts] skipped customer reply alert — preference disabled');
    }
    res.type('text/xml').status(200).send(EMPTY_RESPONSE);
  } catch (err) {
    console.error('[sms] Handler error', err);
    if (!res.headersSent) {
      res.type('text/xml').status(200).send(EMPTY_RESPONSE);
    }
  }
}
