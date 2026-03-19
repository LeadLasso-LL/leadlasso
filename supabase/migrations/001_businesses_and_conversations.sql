-- LeadLasso: one backend, one schema, many businesses.
-- Business is identified by leadlasso_number (the Twilio number that received the call/SMS).

create type setup_type as enum ('forwarding', 'replace_number');
create type plan_status as enum ('active', 'inactive');
create type conversation_status as enum ('active', 'closed');

create table businesses (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  sender_name text,
  owner_phone text not null,
  leadlasso_number text unique,
  auto_reply_template text,
  setup_type setup_type not null default 'replace_number',
  plan_status plan_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_phone text not null,
  owner_phone text not null,
  leadlasso_number text not null,
  status conversation_status not null default 'active',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(business_id, customer_phone)
);

create index idx_conversations_business_id on conversations(business_id);
create index idx_conversations_owner_phone on conversations(owner_phone);
create index idx_conversations_last_message_at on conversations(last_message_at desc nulls last);
create index idx_businesses_leadlasso_number on businesses(leadlasso_number);
