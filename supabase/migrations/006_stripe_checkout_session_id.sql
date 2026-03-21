-- Link each business to the Stripe Checkout Session that completed payment (success URL ?session_id=cs_...).
alter table businesses add column if not exists stripe_checkout_session_id text;

create unique index if not exists idx_businesses_stripe_checkout_session_id
  on businesses (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
