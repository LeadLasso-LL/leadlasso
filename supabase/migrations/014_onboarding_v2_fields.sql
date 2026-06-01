-- Onboarding v2: plan selection, call mode, business hours, Stripe subscription.

alter table businesses add column if not exists first_name text;
alter table businesses add column if not exists call_mode text default 'ai_first';
alter table businesses add column if not exists existing_number text;
alter table businesses add column if not exists sms_opt_in boolean default false;
alter table businesses add column if not exists business_hours jsonb;
alter table businesses add column if not exists stripe_subscription_id text;
