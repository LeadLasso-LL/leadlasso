-- Durable conversation transcript messages (for future portal thread view)

create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  business_id uuid not null references businesses (id) on delete cascade,
  customer_phone text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  sender_type text not null check (sender_type in ('customer', 'owner', 'system')),
  body text not null,
  channel text not null default 'sms' check (channel in ('sms')),
  created_at timestamptz not null default now()
);

create index if not exists idx_conversation_messages_conversation_created
  on conversation_messages (conversation_id, created_at asc);

create index if not exists idx_conversation_messages_business_created
  on conversation_messages (business_id, created_at desc);

alter table conversation_messages enable row level security;

drop policy if exists "Portal: select own conversation messages" on conversation_messages;

create policy "Portal: select own conversation messages"
on conversation_messages for select to authenticated
using (
  exists (
    select 1
    from businesses b
    where b.id = conversation_messages.business_id
      and b.user_id = (select auth.uid ())
  )
);

