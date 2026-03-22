/**
 * Transactional email via Resend.
 * Welcome email sent after successful paid onboarding (webhook and/or success endpoint).
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { Resend } from 'resend';
import type { OnboardingBody } from '../routes/onboarding';

export type WelcomeEmailSetupType = 'replace_number' | 'forwarding';

export type SendWelcomeEmailParams = {
  email: string;
  leadlassoNumber: string;
  setupType: WelcomeEmailSetupType;
  businessName: string;
  senderName: string | null;
  ownerPhone: string;
  forwardToPhone: string | null;
  /** null / empty = use default auto-reply sentence in HTML */
  autoReplyTemplate: string | null;
};

const WELCOME_SUBJECT = "You're live - Your LeadLasso number is ready";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function defaultAutoReplyText(senderName: string, businessName: string): string {
  return `Sorry we missed your call. This is ${senderName} from ${businessName}. How can we help?`;
}

/** Value injected into {{auto_reply_template}}: custom (escaped) or default sentence (escaped). */
function buildAutoReplyHtmlFragment(params: SendWelcomeEmailParams): string {
  const sender = (params.senderName || 'us').trim() || 'us';
  const business = (params.businessName || 'us').trim() || 'us';
  const custom = params.autoReplyTemplate?.trim();
  if (custom) return escapeHtml(custom);
  return escapeHtml(defaultAutoReplyText(sender, business));
}

async function loadWelcomeHtmlTemplate(setupType: WelcomeEmailSetupType): Promise<string> {
  const fileName =
    setupType === 'replace_number' ? 'welcome-replace-number.html' : 'welcome-call-forwarding.html';
  // Dev (ts-node): src/services → ../../emails. Prod: dist/services → ../emails (copied by build).
  const searchRoots = [
    path.join(__dirname, '..', 'emails'),
    path.join(__dirname, '..', '..', 'emails'),
  ];
  let lastErr: unknown;
  for (const root of searchRoots) {
    try {
      return await readFile(path.join(root, fileName), 'utf8');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Replace all {{placeholders}} with escaped or computed values before send.
 */
function fillWelcomeEmailTemplate(html: string, params: SendWelcomeEmailParams): string {
  const sender = (params.senderName || '').trim();
  const business = (params.businessName || '').trim();
  const autoReplyHtml = buildAutoReplyHtmlFragment(params);
  const setupTypeLiteral = params.setupType;
  const forward = (params.forwardToPhone || '').trim();

  const replacements: Record<string, string> = {
    '{{business_name}}': escapeHtml(business),
    '{{sender_name}}': escapeHtml(sender),
    '{{owner_phone}}': escapeHtml(params.ownerPhone || ''),
    '{{leadlasso_number}}': escapeHtml(params.leadlassoNumber || ''),
    '{{auto_reply_template}}': autoReplyHtml,
    '{{setup_type}}': escapeHtml(setupTypeLiteral),
    '{{forward_to_phone}}': escapeHtml(forward),
  };

  let out = html;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value);
  }
  return out;
}

function buildPlainTextFallback(params: SendWelcomeEmailParams): string {
  const lines = [
    `Hi ${(params.senderName || 'there').trim() || 'there'},`,
    '',
    `You're all set — LeadLasso is now live for ${params.businessName}.`,
    '',
    `Your LeadLasso number: ${params.leadlassoNumber}`,
    '',
    'https://getleadlasso.io',
    'contact@getleadlasso.io',
  ];
  return lines.join('\n');
}

/** Map stored onboarding fields + provisioned number to welcome template params. */
export function onboardingBodyToWelcomeParams(
  data: OnboardingBody,
  leadlassoNumber: string
): SendWelcomeEmailParams {
  const setupTypeRaw = data.setup_type?.trim() || '';
  const setupType: WelcomeEmailSetupType =
    setupTypeRaw === 'forward' || setupTypeRaw === 'forwarding' ? 'forwarding' : 'replace_number';
  return {
    email: String(data.email),
    leadlassoNumber,
    setupType,
    businessName: String(data.business_name),
    senderName: data.sender_name?.trim() || null,
    ownerPhone: String(data.owner_phone),
    forwardToPhone:
      data.forward_to_phone != null && String(data.forward_to_phone).trim() !== ''
        ? String(data.forward_to_phone).trim()
        : null,
    autoReplyTemplate: data.auto_reply_template ?? null,
  };
}

/**
 * Sends welcome email for a newly created business (use only right after createBusinessWithNumber).
 * Delegates to {@link sendWelcomeEmail}.
 */
export async function sendWelcomeEmailForOnboarding(
  data: OnboardingBody,
  leadlassoNumber: string
): Promise<void> {
  const params = onboardingBodyToWelcomeParams(data, leadlassoNumber);
  await sendWelcomeEmail(params);
}

/**
 * Sends the welcome email after successful onboarding.
 * Uses RESEND_API_KEY and FROM_EMAIL.
 */
export async function sendWelcomeEmail(params: SendWelcomeEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    console.log('[email] skipped — provider not configured');
    return;
  }

  console.log('[email] sending welcome email', { to: params.email });

  let html: string;
  try {
    const raw = await loadWelcomeHtmlTemplate(params.setupType);
    html = fillWelcomeEmailTemplate(raw, params);
  } catch (err) {
    console.error('[email] failed', err);
    return;
  }

  const resend = new Resend(apiKey);
  const text = buildPlainTextFallback(params);

  try {
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: [params.email],
      subject: WELCOME_SUBJECT,
      html,
      text,
    });
    if (error) {
      console.error('[email] failed', error);
      return;
    }
    console.log('[email] success', { to: params.email });
  } catch (err) {
    console.error('[email] failed', err);
  }
}
