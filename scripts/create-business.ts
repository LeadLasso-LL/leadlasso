/**
 * Create a business in Supabase. Edit the values below, then run:
 *   npx ts-node scripts/create-business.ts
 *
 * For automated number assignment (Phase 5), use assign-number.ts after creating the business.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');

const supabase = createClient(url, key);

async function main() {
  const { data, error } = await supabase.from('businesses').insert({
    business_name: 'Example Business',
    sender_name: 'LeadLasso',
    owner_phone: '+15559876543',
    leadlasso_number: null,
    auto_reply_template: "Thanks for calling! We missed you. Reply to this message and we'll get back to you.",
    setup_type: 'replace_number',
    plan_status: 'active',
  }).select('id, business_name').single();

  if (error) throw error;
  console.log('Created business:', data?.id, data?.business_name);
  console.log('Set leadlasso_number on this row (e.g. in Supabase) to the business\'s Twilio number.');
}

main().catch(console.error);
