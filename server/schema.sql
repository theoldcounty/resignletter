-- Application-owned data. Stripe catalog and events belong to Stripe/stripe-replit-sync.
-- Apply to the development database; Replit Publish transfers the schema to production.
CREATE TABLE public.resignation_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_name varchar(120),
  manager_name varchar(120) NOT NULL,
  company varchar(160) NOT NULL,
  home_address varchar(500),
  office_address varchar(500),
  last_day date NOT NULL,
  reason varchar(1000),
  tone text NOT NULL CHECK (tone IN ('grateful', 'professional', 'direct')),
  payment_mode text NOT NULL CHECK (payment_mode IN ('test', 'live')),
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'cancelled', 'expired', 'refund_pending', 'refunded')),
  stripe_session_id text UNIQUE,
  stripe_price_id text,
  stripe_payment_intent_id text,
  ga_client_id varchar(200),
  letter_text text,
  letter_generated_at timestamptz,
  fulfillment_checked_at timestamptz,
  return_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX resignation_letters_payment_status_idx
  ON public.resignation_letters (payment_status);