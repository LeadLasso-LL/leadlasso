-- Owner-facing SMS notification preferences (portal-editable; default ON for all accounts)

alter table businesses
  add column if not exists owner_new_lead_alerts_enabled boolean not null default true;

alter table businesses
  add column if not exists owner_customer_reply_alerts_enabled boolean not null default true;

comment on column businesses.owner_new_lead_alerts_enabled is
  'When true, send owner an SMS when a new missed-call lead triggers the immediate owner alert.';

comment on column businesses.owner_customer_reply_alerts_enabled is
  'When true, forward customer SMS to the owner phone with lead code context.';

-- Existing rows: NOT NULL DEFAULT true already applied when column is added
