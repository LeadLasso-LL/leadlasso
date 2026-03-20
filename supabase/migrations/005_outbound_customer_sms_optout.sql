-- Track whether the system has ever sent an outbound SMS to a customer phone.
-- Used to ensure opt-out language is included only on the first outbound SMS
-- per unique customer phone number.

create table outbound_customer_sms (
  id uuid primary key default gen_random_uuid(),
  customer_phone text not null unique,
  created_at timestamptz not null default now()
);

