-- Application-owned data. Stripe catalog and events belong to Stripe/stripe-replit-sync.
-- Apply to the development database; Replit Publish transfers the schema to production.
-- Each row is an order and fulfillment record; Stripe references let API routes
-- reconcile provider state without treating browser return parameters as proof.
CREATE TABLE public.resignation_letters (
  -- Database-generated correlation ID shared with Stripe metadata and API calls.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Customer and recipient details are collected for the requested letter.
  sender_name varchar(120),
  manager_name varchar(120) NOT NULL,
  company varchar(160) NOT NULL,
  home_address varchar(500),
  office_address varchar(500),
  last_day date NOT NULL,
  reason varchar(1000),
  -- Match the validated form vocabulary so unsupported tones cannot be stored.
  tone text NOT NULL CHECK (tone IN ('grateful', 'professional', 'direct')),
  -- Keep the selected account mode with the order to prevent test/live mixing.
  payment_mode text NOT NULL CHECK (payment_mode IN ('test', 'live')),
  -- This state machine covers checkout, verified payment, and explicit refund outcomes.
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'cancelled', 'expired', 'refund_pending', 'refunded')),
  -- Provider identifiers link local state to Checkout and its underlying intent.
  stripe_session_id text UNIQUE,
  stripe_price_id text,
  stripe_payment_intent_id text,
  -- Optional analytics correlation; never used to authorize payment or access.
  ga_client_id varchar(200),
  -- Generated text and timestamps make fulfillment durable and idempotent.
  letter_text text,
  letter_generated_at timestamptz,
  -- Reconciliation lease timestamp limits duplicate work across server instances.
  fulfillment_checked_at timestamptz,
  -- Set only when the customer returns; avoids fulfilling abandoned checkouts.
  return_seen_at timestamptz,
  -- Audit timestamps for order creation and subsequent state changes.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Supports operational queries that locate orders by their current payment state.
CREATE INDEX resignation_letters_payment_status_idx
  ON public.resignation_letters (payment_status);