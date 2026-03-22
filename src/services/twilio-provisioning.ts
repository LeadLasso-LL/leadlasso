/**
 * Twilio number provisioning for onboarding.
 * Search US local numbers by area code, purchase, and configure webhooks for LeadLasso.
 */
import { twilioClient, getPublicBaseUrl } from '../lib/twilio';

export interface ProvisionedNumber {
  phoneNumber: string;
  sid: string;
}

/**
 * Find and purchase the first available US local number in the given area code.
 * Configures Voice URL, Voice status callback, and SMS URL for LeadLasso webhooks.
 * @throws if no numbers available or Twilio API error
 */
export async function provisionLocalNumber(areaCode: string): Promise<ProvisionedNumber> {
  const code = areaCode.replace(/\D/g, '').slice(0, 3);
  if (code.length !== 3) throw new Error('Invalid area code');
  const areaCodeNum = parseInt(code, 10);
  if (Number.isNaN(areaCodeNum)) throw new Error('Invalid area code');

  const available = await twilioClient.availablePhoneNumbers('US').local.list({
    areaCode: areaCodeNum,
    limit: 1,
  });

  if (!available || available.length === 0) {
    throw new Error('NO_NUMBERS_AVAILABLE');
  }

  const baseUrl = getPublicBaseUrl();
  const voiceUrl = `${baseUrl}/webhooks/incoming-call`;
  const voiceStatusUrl = `${baseUrl}/webhooks/incoming-call/status`;
  const smsUrl = `${baseUrl}/webhooks/incoming-sms`;

  const purchased = await twilioClient.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    voiceUrl,
    voiceMethod: 'POST',
    statusCallback: voiceStatusUrl,
    statusCallbackMethod: 'POST',
    smsUrl,
    smsMethod: 'POST',
  });

  return {
    phoneNumber: purchased.phoneNumber ?? available[0].phoneNumber,
    sid: purchased.sid,
  };
}

/**
 * Release a purchased Twilio number (e.g. cleanup after failed DB insert).
 */
export async function releaseNumber(sid: string): Promise<void> {
  await twilioClient.incomingPhoneNumbers(sid).remove();
}
