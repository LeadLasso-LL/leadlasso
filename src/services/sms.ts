/**
 * Send SMS via Twilio. Used when forwarding to owner, replying to customer, or sending auto-reply.
 * All sends use the business's LeadLasso number as From so replies come back to the same webhook.
 */
import { twilioClient } from '../lib/twilio';

/**
 * Send one SMS. Caller is responsible for storing message in DB if needed (e.g. when we add messages table).
 */
export async function sendSms(params: {
  from: string;
  to: string;
  body: string;
}): Promise<{ sid: string }> {
  const result = await twilioClient.messages.create({
    from: params.from,
    to: params.to,
    body: params.body,
  });
  return { sid: result.sid };
}
