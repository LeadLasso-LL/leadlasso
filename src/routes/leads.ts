/**
 * PATCH /api/leads/:id/status — update lead status for the authenticated business owner.
 */
import { Request, Response } from 'express';
import { getBearerUser, getBusinessForUser } from '../lib/auth';
import { supabase } from '../lib/supabase';

const VALID_STATUSES = new Set(['new', 'contacted', 'booked', 'completed', 'lost', 'no_lead']);

export async function handlePatchLeadStatus(req: Request, res: Response): Promise<void> {
  try {
    const user = await getBearerUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const business = await getBusinessForUser(user.id);
    if (!business) {
      res.status(403).json({ success: false, error: 'No business linked to this account' });
      return;
    }

    const leadId = String(req.params.id ?? '').trim();
    if (!leadId) {
      res.status(400).json({ success: false, error: 'Missing lead id' });
      return;
    }

    const status = String(req.body?.status ?? '').trim();
    if (!VALID_STATUSES.has(status)) {
      res.status(400).json({ success: false, error: 'Invalid status' });
      return;
    }

    const { data: lead, error: fetchErr } = await supabase
      .from('leads')
      .select('id, business_id')
      .eq('id', leadId)
      .maybeSingle();

    if (fetchErr) {
      console.error('[leads] fetch lead failed', fetchErr);
      res.status(500).json({ success: false, error: 'Could not load lead' });
      return;
    }
    if (!lead) {
      res.status(404).json({ success: false, error: 'Lead not found' });
      return;
    }
    if (lead.business_id !== business.id) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const { data: updated, error: updErr } = await supabase
      .from('leads')
      .update({ status })
      .eq('id', leadId)
      .select('id, status')
      .single();

    if (updErr) {
      console.error('[leads] status update failed', updErr);
      res.status(500).json({ success: false, error: 'Could not update status' });
      return;
    }

    res.json({ success: true, lead: updated });
  } catch (err) {
    console.error('[leads] PATCH status error', err);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
}
