/**
 * POST /api/support/escalate — notify Juvo team of a support escalation.
 * POST /api/support/chat — proxy support chat to Anthropic (keeps API key server-side).
 */
import { Request, Response } from 'express';
import { Resend } from 'resend';
import { getBearerUser, getBusinessForUser } from '../lib/auth';
import { twilioClient } from '../lib/twilio';

const SUPPORT_EMAIL = 'hello@getjuvo.io';

const SUPPORT_SYSTEM_PROMPT = `You are a friendly, knowledgeable support assistant for Juvo — an AI receptionist SaaS for home service businesses (plumbers, HVAC, electricians, landscapers, etc.).

Juvo's core product: An AI voice receptionist that answers every call, captures lead info (name, phone number, job description), and notifies the business owner instantly. Business owners manage their leads through the Juvo dashboard at getjuvo.io/dashboard.

Your job:
1. Help business owners with questions about using Juvo
2. Troubleshoot common issues
3. Be warm, concise, and helpful — these are busy tradespeople, not tech people

Common topics you can help with:
- How leads are captured and appear in the dashboard
- How to update lead status (New, Contacted, Booked, Completed, Lost, No Lead)
- How the AI voice agent works
- Call forwarding vs replacing their number
- Billing and plan questions (Starter: $97/mo, Pro: $197/mo)
- How to read call transcripts
- General account questions

When you cannot resolve an issue or the customer needs human help:
- Acknowledge what they need
- Tell them you're flagging it for the Juvo team
- End your message with exactly this JSON block on its own line:
ESCALATE:{"summary":"<one sentence summary of the issue>","resolved":false,"needs_human":true}

When the conversation reaches a natural resolution:
- Confirm the issue is resolved
- End your message with exactly this JSON block on its own line:
RESOLVED:{"summary":"<one sentence summary of what was resolved>","resolved":true,"needs_human":false}

Keep responses under 3 sentences unless a detailed explanation is needed. Never make up features that don't exist. If unsure, say so and offer to connect them with the team.`;

type EscalationBody = {
  summary?: string;
  resolved?: boolean;
  needs_human?: boolean;
  business_name?: string;
  business_id?: string;
};

type ChatMessage = { role: string; content: string };

function resolveFromEmail(): string {
  return process.env.FROM_EMAIL?.trim() || 'Juvo <hello@getjuvo.io>';
}

export async function handleSupportEscalate(req: Request, res: Response): Promise<void> {
  try {
    const user = await getBearerUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const business = await getBusinessForUser(user.id);
    const body = req.body as EscalationBody;
    const summary = String(body.summary ?? '').trim();
    if (!summary) {
      res.status(400).json({ success: false, error: 'Missing summary' });
      return;
    }

    const businessName = String(body.business_name ?? business?.business_name ?? '').trim();
    const businessId = String(body.business_id ?? business?.id ?? '').trim();
    const label = businessName || user.email || 'Unknown business';
    const smsBody = `Juvo support escalation (${label}): ${summary}`;

    const supportPhone = process.env.SUPPORT_PHONE?.trim();
    const smsFrom = process.env.TWILIO_SUPPORT_FROM?.trim();

    if (supportPhone && smsFrom) {
      await twilioClient.messages.create({ from: smsFrom, to: supportPhone, body: smsBody });
      console.log('[support] escalation SMS sent');
    } else {
      console.warn('[support] skip SMS — set SUPPORT_PHONE and TWILIO_SUPPORT_FROM');
    }

    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      const resend = new Resend(resendKey);
      const { error } = await resend.emails.send({
        from: resolveFromEmail(),
        to: [SUPPORT_EMAIL],
        subject: `Support escalation — ${label}`,
        text: [
          smsBody,
          '',
          `Resolved: ${body.resolved ? 'yes' : 'no'}`,
          `Needs human: ${body.needs_human !== false ? 'yes' : 'no'}`,
          businessId ? `Business ID: ${businessId}` : '',
          user.email ? `User: ${user.email}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      if (error) {
        console.error('[support] escalation email failed', error);
      } else {
        console.log('[support] escalation email sent');
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[support] escalate error', err);
    res.status(500).json({ success: false, error: 'Failed to send escalation' });
  }
}

export async function handleSupportChat(req: Request, res: Response): Promise<void> {
  try {
    const user = await getBearerUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(503).json({ success: false, error: 'Support chat not configured' });
      return;
    }

    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      res.status(400).json({ success: false, error: 'Missing messages' });
      return;
    }

    const messages: ChatMessage[] = rawMessages
      .filter((m: unknown) => m && typeof m === 'object')
      .map((m: { role?: string; content?: string }) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content ?? '').trim(),
      }))
      .filter((m) => m.content);

    if (!messages.length) {
      res.status(400).json({ success: false, error: 'Invalid messages' });
      return;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SUPPORT_SYSTEM_PROMPT,
        messages,
      }),
    });

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      console.error('[support] chat API error', data);
      res.status(502).json({
        success: false,
        error: data.error?.message || 'Support chat unavailable',
      });
      return;
    }

    const reply =
      data.content?.find((block) => block.type === 'text')?.text ||
      "I'm having trouble right now. Please try again or contact hello@getjuvo.io.";

    res.json({ success: true, reply });
  } catch (err) {
    console.error('[support] chat error', err);
    res.status(500).json({ success: false, error: 'Support chat failed' });
  }
}
