-- Safety migration: ensure the owner-reply intro flag exists on conversations.
-- Some environments may have missed migration 004.

alter table conversations
  add column if not exists requires_owner_reply_intro_on_next_sms boolean not null default false;

