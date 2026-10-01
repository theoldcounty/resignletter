-- Apply once to an existing development database before running the updated app.
-- For a Replit-managed production database, Publish transfers the development schema.
-- Keep this upgrade in a transaction so the API never observes only part of the
-- fields or payment-state constraint required for delivery and reconciliation.
BEGIN;

-- Add delivery-related fields to existing orders without affecting deployed data.
-- IF NOT EXISTS makes a rerun safe if setup stopped after an earlier application.
ALTER TABLE public.resignation_letters
  ADD COLUMN IF NOT EXISTS sender_name varchar(120),
  ADD COLUMN IF NOT EXISTS home_address varchar(500),
  ADD COLUMN IF NOT EXISTS office_address varchar(500),
  ADD COLUMN IF NOT EXISTS letter_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_price_id text,
  ADD COLUMN IF NOT EXISTS fulfillment_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_seen_at timestamptz;

-- Replace the prior state constraint as a unit: refund_pending and refunded are
-- required to distinguish a requested refund from a Stripe-confirmed refund.
ALTER TABLE public.resignation_letters
  DROP CONSTRAINT IF EXISTS resignation_letters_payment_status_check;

ALTER TABLE public.resignation_letters
  ADD CONSTRAINT resignation_letters_payment_status_check
  CHECK (payment_status IN (
    'pending', 'paid', 'failed', 'cancelled', 'expired', 'refund_pending', 'refunded'
  ));

COMMIT;