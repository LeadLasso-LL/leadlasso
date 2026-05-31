/**
 * Retell webhook signature verification (HMAC-SHA256).
 * @see https://docs.retellai.com/features/secure-webhook
 */
import crypto from 'crypto';

const SIGNATURE_RE = /v=(\d+),d=(.*)/;
const MAX_AGE_MS = 5 * 60 * 1000;

export function verifyRetellWebhook(
  rawBody: string,
  apiKey: string,
  signature: string | undefined
): boolean {
  if (!signature || !apiKey) return false;

  const matches = SIGNATURE_RE.exec(signature);
  if (!matches) return false;

  const timestamp = matches[1];
  const digest = matches[2];

  const timestampMs = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampMs)) return false;

  const now = Date.now();
  if (Math.abs(now - timestampMs) > MAX_AGE_MS) return false;

  const expected = crypto
    .createHmac('sha256', apiKey)
    .update(rawBody + timestamp)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest, 'hex'));
  } catch {
    return false;
  }
}
