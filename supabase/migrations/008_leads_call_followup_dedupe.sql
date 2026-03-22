-- Idempotent missed-call follow-up: tie each lead to Twilio CallSid, track outbound SMS completion for retries.

alter table leads add column if not exists source_twilio_call_sid text;

alter table leads add column if not exists auto_reply_sent_at timestamptz;

alter table leads add column if not exists owner_missed_call_alert_sent_at timestamptz;

create unique index if not exists idx_leads_source_twilio_call_sid
  on leads (source_twilio_call_sid)
  where
    source_twilio_call_sid is not null;

-- Portal users must not rewrite server-owned follow-up fields
create or replace function public.leads_portal_update_guard ()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce((select auth.jwt () ->> 'role'), '') = 'authenticated' then
    if new.id is distinct from old.id
      or new.business_id is distinct from old.business_id
      or new.caller_phone is distinct from old.caller_phone
      or new.created_at is distinct from old.created_at
      or new.source_twilio_call_sid is distinct from old.source_twilio_call_sid
      or new.auto_reply_sent_at is distinct from old.auto_reply_sent_at
      or new.owner_missed_call_alert_sent_at is distinct from old.owner_missed_call_alert_sent_at
    then
      raise exception 'Cannot modify lead identity fields'
        using errcode = '42501';
    end if;
    if old.status = 'booked' and new.status is distinct from old.status then
      raise exception 'Lead is already booked'
        using errcode = '42501';
    end if;
    if new.status = 'booked' and old.status = 'new' then
      new.booked_at := coalesce(new.booked_at, now());
    end if;
  end if;
  return new;
end;
$fn$;
