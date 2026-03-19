/**
 * Twilio client and webhook URL helper.
 * All LeadLasso numbers point to the same webhook URLs; the backend identifies
 * the business by the Twilio number (To) that received the call or SMS.
 */
import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
}

export const twilioClient = twilio(accountSid, authToken);

/** Base URL for TwiML action URLs (e.g. dial-action). No trailing slash. */
export function getWebhookBaseUrl(): string {
  const base = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (!base) throw new Error('TWILIO_WEBHOOK_BASE_URL must be set');
  return base.replace(/\/$/, '');
}

/** Public backend base URL for webhook endpoints (e.g. onboarding number config). No trailing slash. */
export function getPublicBaseUrl(): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error('PUBLIC_BASE_URL must be set');
  return base.replace(/\/$/, '');
}
