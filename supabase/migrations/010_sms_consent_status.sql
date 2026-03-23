-- SMS consent tracking (STOP/START/HELP) for customer-facing outbound messages
-- Uses the existing outbound_customer_sms table as the durable per-number record.

alter table outbound_customer_sms
  add column if not exists sms_consent_status text not null default 'subscribed'
  check (sms_consent_status in ('subscribed', 'unsubscribed', 'unknown')),
  add column if not exists opted_out_at timestamptz null,
  add column if not exists opted_in_at timestamptz null,
  add column if not exists last_opt_keyword text null,
  add column if not exists last_opt_event_source text null,
  add column if not exists has_sent_any_outbound boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

-- Preserve existing behavior: older rows already represent "we sent at least once".
update outbound_customer_sms
set has_sent_any_outbound = true,
    sms_consent_status = coalesce(sms_consent_status, 'subscribed');

create or replace function public.set_outbound_customer_sms_updated_at ()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists tr_outbound_customer_sms_set_updated_at on outbound_customer_sms;

create trigger tr_outbound_customer_sms_set_updated_at
before update on outbound_customer_sms
for each row
execute function public.set_outbound_customer_sms_updated_at ();

