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
  /** Supabase recovery link for first-time password setup (new auth users only) */
  setPasswordUrl?: string | null;
};

const WELCOME_SUBJECT = "You're live - Your LeadLasso number is ready";
const PASSWORD_RESET_SUBJECT = 'Reset your LeadLasso password';

type SendPasswordResetEmailParams = {
  email: string;
  actionLink: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * CTA block for welcome email when set_password_url is provided (new auth users).
 * Uses table + bgcolor on &lt;td&gt; so Gmail/Outlook still show a white “button” if &lt;a&gt; styles are stripped.
 */
function buildSetPasswordCtaBlock(setPasswordUrl: string | null | undefined): string {
  const url = setPasswordUrl?.trim();
  if (!url) return '';
  const href = escapeHtmlAttr(url);
  const label = 'Set your password to access your LeadLasso dashboard';
  return [
    '<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;margin:14px 0 0 0;">',
    '<tr><td align="center" valign="top" style="padding:0;">',
    '<p style="margin:0 0 8px 0;font-family:Poppins,Arial,sans-serif;font-size:11px;line-height:1.35;font-weight:600;color:#ffffff;text-transform:uppercase;letter-spacing:0.12em;">Customer dashboard</p>',
    '<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">',
    '<tr>',
    '<td align="center" bgcolor="#ffffff" style="background-color:#ffffff;border-radius:10px;border:2px solid #ffffff;">',
    `<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:block;padding:12px 24px;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:600;line-height:1.4;color:#E13C3C;text-decoration:none;text-align:center;mso-line-height-rule:exactly;">${label}</a>`,
    '</td>',
    '</tr>',
    '</table>',
    '<p style="margin:8px 0 0 0;font-family:Inter,Arial,sans-serif;font-size:12px;line-height:1.45;font-weight:400;color:#ffffff;opacity:0.92;">This secure link expires. After setting your password, sign in at your portal with email and password.</p>',
    '</td></tr></table>',
  ].join('');
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
    '{{set_password_cta_block}}': buildSetPasswordCtaBlock(params.setPasswordUrl),
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
  ];
  if (params.setPasswordUrl?.trim()) {
    lines.push('Set your password (one-time secure link):', params.setPasswordUrl.trim(), '');
  }
  lines.push('https://getleadlasso.io', 'contact@getleadlasso.io');
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
  leadlassoNumber: string,
  setPasswordUrl?: string | null
): Promise<void> {
  const params: SendWelcomeEmailParams = {
    ...onboardingBodyToWelcomeParams(data, leadlassoNumber),
    setPasswordUrl: setPasswordUrl ?? null,
  };
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

  console.log('[email] sending welcome email');

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
    console.log('[email] success');
  } catch (err) {
    console.error('[email] failed', err);
  }
}

function buildPasswordResetHtml(actionLink: string): string {
  const link = escapeHtmlAttr(actionLink);
  const prettyLink = escapeHtml(actionLink);

  const primary = '#e13c3c';
  const secondary = '#db7676';

  // Table-based layout for broad email client support.
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Reset your LeadLasso password</title>',
    '<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">',
    '</head>',
    '<body style="margin:0;padding:0;background: linear-gradient(180deg, ' +
      primary +
      ' 0%, ' +
      secondary +
      ' 100%);background-color:' +
      primary +
      ';font-family:Inter,Arial,sans-serif;color:#ffffff;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">',
    '<tr>',
    '<td align="center" style="padding:48px 16px;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;border-collapse:collapse;">',
    '<tr>',
    '<td style="text-align:center;padding:0 8px;">',
    '<h1 style="margin:0 0 10px 0;font-family:Poppins,Arial,sans-serif;font-size:28px;line-height:1.2;font-weight:700;color:#ffffff;">Reset your password</h1>',
    '<p style="margin:0 0 22px 0;font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;font-weight:400;opacity:0.92;">Click below to set a new password for your LeadLasso account.</p>',
    '</td>',
    '</tr>',
    '<tr>',
    '<td align="center" style="padding:0 8px 8px 8px;">',
    '<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">',
    '<tr>',
    '<td align="center" bgcolor="#ffffff" style="border-radius:12px;">',
    '<a href="' +
      link +
      '" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 26px;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:600;line-height:1.4;color:' +
      primary +
      ';text-decoration:none;border-radius:12px;">Reset Password</a>',
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '<tr>',
    '<td align="center" style="padding:8px 8px 0 8px;">',
    '<p style="margin:10px 0 0 0;font-size:13px;line-height:1.45;color:#ffffff;opacity:0.95;">',
    '<a href="' + link + '" target="_blank" rel="noopener noreferrer" style="color:#ffffff;text-decoration:underline;word-break:break-all;">' +
      prettyLink +
      '</a>',
    '</p>',
    '</td>',
    '</tr>',
    '<tr>',
    '<td style="padding:26px 8px 0 8px;text-align:center;">',
    '<p style="margin:0;font-size:12px;line-height:1.5;color:#ffffff;opacity:0.9;">If you didn’t request this, you can safely ignore this email.</p>',
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
}

function buildPasswordResetText(params: SendPasswordResetEmailParams): string {
  return [
    'Reset your LeadLasso password',
    '',
    'Click this link to set a new password:',
    params.actionLink,
    '',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n');
}

export async function sendPasswordResetEmail(params: SendPasswordResetEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'LeadLasso <setup@getleadlasso.io>';
  if (!apiKey || !fromEmail) {
    console.log('[email] skipped — provider not configured');
    return;
  }

  const resend = new Resend(apiKey);
  const html = buildPasswordResetHtml(params.actionLink);
  const text = buildPasswordResetText(params);

  const { error } = await resend.emails.send({
    from: fromEmail,
    to: [params.email],
    subject: PASSWORD_RESET_SUBJECT,
    html,
    text,
  });

  if (error) {
    console.error('[email] password reset failed', error);
    return;
  }

  console.log('[email] password reset success');
}
