-- Juvo schema rebuild: voice receptionist (Retell AI), no SMS conversations.
-- Renames leadlasso_number → juvo_number, drops SMS/conversation tables, rebuilds leads.

-- ── Drop SMS / conversation artifacts ──
drop policy if exists "Portal: select own conversation messages" on conversation_messages;
drop table if exists conversation_messages cascade;
drop table if exists conversations cascade;
drop table if exists outbound_customer_sms cascade;

-- ── Rebuild leads (old table was missed-call SMS follow-up) ──
drop trigger if exists tr_leads_portal_update_guard on leads;
drop table if exists leads cascade;

-- ── Businesses: rename column, drop SMS fields, add Retell / industry ──
alter table businesses rename column leadlasso_number to juvo_number;

alter table businesses drop column if exists sender_name;
alter table businesses drop column if exists auto_reply_template;

alter table businesses add column if not exists retell_agent_id text;
alter table businesses add column if not exists industry text;

drop index if exists idx_businesses_leadlasso_number;
create index if not exists idx_businesses_juvo_number on businesses (juvo_number);

-- Protected-columns trigger: column rename only (RLS policies unchanged)
create or replace function public.businesses_lock_protected_columns ()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce((select auth.jwt () ->> 'role'), '') = 'authenticated' then
    if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.email is distinct from old.email
      or new.juvo_number is distinct from old.juvo_number
      or new.preferred_area_code is distinct from old.preferred_area_code
      or new.stripe_customer_id is distinct from old.stripe_customer_id
      or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
      or new.setup_type is distinct from old.setup_type
      or new.plan_status is distinct from old.plan_status
      or new.retell_agent_id is distinct from old.retell_agent_id
      or new.created_at is distinct from old.created_at
    then
      raise exception 'Cannot modify protected fields on businesses'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

-- ── New leads table (Retell / voice capture) ──
create table leads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  caller_name text,
  caller_number text not null,
  job_description text,
  call_id text unique,
  recording_url text,
  transcript text,
  status text not null default 'new',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_leads_business_id on leads (business_id);
create index idx_leads_created_at on leads (created_at desc);
create index idx_leads_status on leads (status);

create or replace function public.set_leads_updated_at ()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists tr_leads_set_updated_at on leads;

create trigger tr_leads_set_updated_at
before update on leads for each row
execute function public.set_leads_updated_at ();

-- Portal users may only update status (e.g. mark booked), not rewrite capture data
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
      or new.caller_name is distinct from old.caller_name
      or new.caller_number is distinct from old.caller_number
      or new.job_description is distinct from old.job_description
      or new.call_id is distinct from old.call_id
      or new.recording_url is distinct from old.recording_url
      or new.transcript is distinct from old.transcript
      or new.created_at is distinct from old.created_at
    then
      raise exception 'Cannot modify lead identity fields'
        using errcode = '42501';
    end if;
    if old.status = 'booked' and new.status is distinct from old.status then
      raise exception 'Lead is already booked'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists tr_leads_portal_update_guard on leads;

create trigger tr_leads_portal_update_guard
before update on leads for each row
execute function public.leads_portal_update_guard ();

alter table leads enable row level security;

drop policy if exists "Portal: select own leads" on leads;

create policy "Portal: select own leads" on leads for select to authenticated using (
  exists (
    select 1
    from businesses b
    where
      b.id = leads.business_id
      and b.user_id = (select auth.uid ())
  )
);

drop policy if exists "Portal: update own leads" on leads;

create policy "Portal: update own leads" on leads for update to authenticated using (
  exists (
    select 1
    from businesses b
    where
      b.id = leads.business_id
      and b.user_id = (select auth.uid ())
  )
)
with
  check (
    exists (
      select 1
      from businesses b
      where
        b.id = leads.business_id
        and b.user_id = (select auth.uid ())
    )
  );

-- conversation_status enum no longer referenced
drop type if exists conversation_status;
