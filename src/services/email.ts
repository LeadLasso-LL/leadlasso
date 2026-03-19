/**
 * Transactional email via Resend.
 * Welcome email sent after successful paid onboarding.
 */
import { Resend } from 'resend';

export type WelcomeEmailSetupType = 'replace_number' | 'forwarding';

export type SendWelcomeEmailParams = {
  firstName: string;
  email: string;
  leadlassoNumber: string;
  setupType: WelcomeEmailSetupType;
};

function buildReplaceNumberBody(firstName: string, leadlassoNumber: string): string {
  return `Hi ${firstName},

You're all set.

Your LeadLasso number:
${leadlassoNumber}

---

Next step:

Use this as your business number anywhere customers call you.

Examples:
Google Business Profile
Your website
Facebook page
Online ads

---

How it works:

1. A customer calls your LeadLasso number
2. We instantly forward the call to your business phone
3. If you miss the call, LeadLasso automatically texts the customer
4. They can reply and you can close the job

---

Example message you'll receive:

New missed call lead A7F2
From: +14135551234

Hi, I was calling about plumbing work.

Reply with:
A7F2 Yes we can help. What seems to be the issue?

LeadLasso removes the code before sending your reply to the customer.

The code simply makes sure your message goes to the right lead, especially when multiple customers are texting you at the same time.

---

Tip:
The faster you reply, the more likely you are to win the job.

You're live.`;
}

function buildForwardBody(firstName: string, leadlassoNumber: string): string {
  const leadlassoNumberDigitsOnly = leadlassoNumber.replace(/\D/g, '');
  return `Hi ${firstName},

You're almost live.

Your LeadLasso number:
${leadlassoNumber}

---

Next step:

Enable conditional call forwarding for missed calls (no-answer forwarding) to your LeadLasso number.

Most carriers support dialing:
*61*${leadlassoNumberDigitsOnly}#

Do NOT use standard iPhone "Call Forwarding" — this forwards all calls.

If that code does not work, search:
"conditional call forwarding + your carrier"

---

Once enabled, when you miss a call:
LeadLasso will instantly text the customer for you.

Because call forwarding depends on carrier setup, this option captures most missed call leads.

If you want LeadLasso to capture all missed call leads automatically, use LeadLasso as your business number instead.

---

How it works:

1. A customer calls your business
2. You miss the call
3. The call forwards to LeadLasso
4. LeadLasso instantly texts the customer
5. They reply and you can close the job

---

Example message you'll receive:

New missed call lead A7F2
From: +14135551234

Hi, I was calling about plumbing work.

Reply with:
A7F2 Yes we can help. What seems to be the issue?

LeadLasso removes the code before sending your reply to the customer.

The code simply makes sure your message goes to the right lead, especially when multiple customers are texting you at the same time.

---

Tip:
The faster you reply, the more likely you are to win the job.

You're live once call forwarding is enabled.`;
}

/**
 * Sends the welcome email after successful onboarding.
 * Uses RESEND_API_KEY and FROM_EMAIL. No-op if either is missing.
 */
export async function sendWelcomeEmail(params: SendWelcomeEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    return;
  }

  const resend = new Resend(apiKey);
  const isReplace = params.setupType === 'replace_number';
  const subject = isReplace ? "You're live — your LeadLasso number is ready" : 'Finish your LeadLasso setup';
  const text = isReplace
    ? buildReplaceNumberBody(params.firstName, params.leadlassoNumber)
    : buildForwardBody(params.firstName, params.leadlassoNumber);

  try {
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: [params.email],
      subject,
      text,
    });
    if (error) {
      console.error('[email] Welcome email failed', error);
    }
  } catch (err) {
    console.error('[email] Welcome email error', err);
  }
}
