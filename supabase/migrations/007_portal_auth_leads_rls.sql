-- Portal: auth.users link, leads table, RLS, claim RPC, protected column triggers

-- Ensure email exists for matching portal login to onboarding row
alter table businesses add column if not exists email text;

alter table businesses add column if not exists user_id uuid references auth.users (id) on delete set null;

create index if not exists idx_businesses_user_id on businesses (user_id);

-- Leads (missed-call captures shown in customer portal)
create table if not exists leads (
  id uuid primary key default gen_random_uuid (),
  business_id uuid not null references businesses (id) on delete cascade,
  caller_phone text not null,
  status text not null default 'new' check (status in ('new', 'booked')),
  created_at timestamptz not null default now(),
  booked_at timestamptz
);

create index if not exists idx_leads_business_created on leads (business_id, created_at desc);

-- updated_at maintenance
create or replace function public.set_businesses_updated_at ()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists tr_businesses_set_updated_at on businesses;

create trigger tr_businesses_set_updated_at
before update on businesses for each row
execute function public.set_businesses_updated_at ();

-- Authenticated portal users cannot change provisioning / billing / identity fields
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
      or new.leadlasso_number is distinct from old.leadlasso_number
      or new.preferred_area_code is distinct from old.preferred_area_code
      or new.stripe_customer_id is distinct from old.stripe_customer_id
      or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
      or new.setup_type is distinct from old.setup_type
      or new.plan_status is distinct from old.plan_status
      or new.created_at is distinct from old.created_at
    then
      raise exception 'Cannot modify protected fields on businesses'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists tr_businesses_lock_protected on businesses;

create trigger tr_businesses_lock_protected
before update on businesses for each row
execute function public.businesses_lock_protected_columns ();

-- Leads: portal may only book (status + booked_at), not rewrite history
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

drop trigger if exists tr_leads_portal_update_guard on leads;

create trigger tr_leads_portal_update_guard
before update on leads for each row
execute function public.leads_portal_update_guard ();

-- Link first business row (by onboarding email) to the signed-in user
create or replace function public.claim_business_for_current_user ()
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  uid uuid;
  em text;
  bid uuid;
begin
  uid := auth.uid ();
  if uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select lower(trim(coalesce(u.email, '')))
  into em
  from auth.users u
  where u.id = uid;

  if em is null or em = '' then
    return json_build_object('ok', false, 'error', 'no_email');
  end if;

  select b.id into bid from businesses b where b.user_id = uid limit 1;
  if bid is not null then
    return json_build_object('ok', true, 'business_id', bid, 'already_linked', true);
  end if;

  update businesses b
  set
    user_id = uid
  from (
    select id
    from businesses
    where
      lower(trim(coalesce(email, ''))) = em
      and user_id is null
    order by created_at asc
    limit 1
  ) sub
  where
    b.id = sub.id
  returning b.id into bid;

  if bid is not null then
    return json_build_object('ok', true, 'business_id', bid);
  end if;

  return json_build_object('ok', false, 'error', 'no_matching_business');
end;
$fn$;

revoke all on function public.claim_business_for_current_user () from public;

grant execute on function public.claim_business_for_current_user () to authenticated;

-- RLS
alter table businesses enable row level security;

alter table leads enable row level security;

drop policy if exists "Portal: select own business" on businesses;

create policy "Portal: select own business" on businesses for select to authenticated using (user_id = (select auth.uid ()));

drop policy if exists "Portal: update own business" on businesses;

create policy "Portal: update own business" on businesses for update to authenticated using (user_id = (select auth.uid ()))
with
  check (user_id = (select auth.uid ()));

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
