-- Onboarding: forward_to_phone, preferred_area_code, stripe_customer_id (optional for existing rows).

alter table businesses
  add column if not exists forward_to_phone text,
  add column if not exists preferred_area_code text,
  add column if not exists stripe_customer_id text;
