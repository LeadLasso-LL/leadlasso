/**
 * Transactional email via Resend.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { Resend } from 'resend';
import type { OnboardingBody } from '../routes/onboarding';

export type WelcomeEmailSetupType = 'replace_number' | 'forwarding';

export type SendWelcomeEmailParams = {
  email: string;
  juvoNumber: string;
  setupType: WelcomeEmailSetupType;
  businessName: string;
  ownerPhone: string;
  forwardToPhone: string | null;
  setPasswordUrl?: string | null;
};

const WELCOME_SUBJECT = "You're live - Your Juvo number is ready";
const PASSWORD_RESET_SUBJECT = 'Reset your Juvo password';

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

function buildSetPasswordCtaBlock(setPasswordUrl: string | null | undefined): string {
  const url = setPasswordUrl?.trim();
  if (!url) return '';
  const href = escapeHtmlAttr(url);
  const label = 'Set your password to access your Juvo dashboard';
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

async function loadWelcomeHtmlTemplate(setupType: WelcomeEmailSetupType): Promise<string> {
  const fileName =
    setupType === 'replace_number' ? 'welcome-replace-number.html' : 'welcome-call-forwarding.html';
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

function fillWelcomeEmailTemplate(html: string, params: SendWelcomeEmailParams): string {
  const business = (params.businessName || '').trim();
  const forward = (params.forwardToPhone || '').trim();

  const replacements: Record<string, string> = {
    '{{business_name}}': escapeHtml(business),
    '{{sender_name}}': 'there',
    '{{owner_phone}}': escapeHtml(params.ownerPhone || ''),
    '{{juvo_number}}': escapeHtml(params.juvoNumber || ''),
    '{{leadlasso_number}}': escapeHtml(params.juvoNumber || ''),
    '{{auto_reply_template}}': '',
    '{{setup_type}}': escapeHtml(params.setupType),
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
    'Hi there,',
    '',
    `You're all set — Juvo is now live for ${params.businessName}.`,
    '',
    `Your Juvo number: ${params.juvoNumber}`,
    '',
  ];
  if (params.setPasswordUrl?.trim()) {
    lines.push('Set your password (one-time secure link):', params.setPasswordUrl.trim(), '');
  }
  lines.push('https://getjuvo.io', 'contact@getjuvo.io');
  return lines.join('\n');
}

export function onboardingBodyToWelcomeParams(
  data: OnboardingBody,
  juvoNumber: string
): SendWelcomeEmailParams {
  const setupTypeRaw = data.setup_type?.trim() || '';
  const setupType: WelcomeEmailSetupType =
    setupTypeRaw === 'forward' || setupTypeRaw === 'forwarding' ? 'forwarding' : 'replace_number';
  return {
    email: String(data.email),
    juvoNumber,
    setupType,
    businessName: String(data.business_name),
    ownerPhone: String(data.owner_phone),
    forwardToPhone:
      data.forward_to_phone != null && String(data.forward_to_phone).trim() !== ''
        ? String(data.forward_to_phone).trim()
        : null,
  };
}

export async function sendWelcomeEmailForOnboarding(
  data: OnboardingBody,
  juvoNumber: string,
  setPasswordUrl?: string | null
): Promise<void> {
  const params: SendWelcomeEmailParams = {
    ...onboardingBodyToWelcomeParams(data, juvoNumber),
    setPasswordUrl: setPasswordUrl ?? null,
  };
  await sendWelcomeEmail(params);
}

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
  const primary = '#e13c3c';
  const secondary = '#db7676';

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Reset your Juvo password</title>',
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
    '<p style="margin:0 0 22px 0;font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;font-weight:400;opacity:0.92;">Click below to set a new password for your Juvo account.</p>',
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
    'Reset your Juvo password',
    '',
    'Click the "Reset Password" button in this email to set a new password.',
    '',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n');
}

export async function sendPasswordResetEmail(params: SendPasswordResetEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'Juvo <setup@getjuvo.io>';
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
