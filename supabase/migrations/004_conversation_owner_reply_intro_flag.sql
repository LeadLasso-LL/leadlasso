-- When true, the next inbound SMS from this customer should use the full owner intro (code + reply instructions).
-- Set on missed-call prep; cleared after that intro is sent to the owner.
alter table conversations
  add column if not exists requires_owner_reply_intro_on_next_sms boolean not null default false;
