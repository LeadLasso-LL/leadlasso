-- Add 4-character conversation code for owner-reply routing.
-- New conversations get a code on creation; existing rows remain null.

alter table conversations
  add column if not exists conversation_code text;

create unique index if not exists idx_conversations_active_code
  on conversations(conversation_code)
  where status = 'active' and conversation_code is not null;
