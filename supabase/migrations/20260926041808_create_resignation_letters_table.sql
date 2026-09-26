/*
# Create resignation_letters table (single-tenant, no auth)

1. New Tables
- `resignation_letters`
  - `id` (uuid, primary key)
  - `manager_name` (text, not null) — the recipient manager's name
  - `company` (text, not null) — the company name
  - `last_day` (text, not null) — the user's last working day
  - `reason` (text, nullable) — optional reason for resigning
  - `tone` (text, not null) — tone selection: grateful, professional, or direct
  - `letter_text` (text, nullable) — the generated letter content
  - `paid` (boolean, default false) — whether payment was completed
  - `payment_intent_id` (text, nullable) — Stripe payment intent ID
  - `created_at` (timestamptz, default now)

2. Security
- Enable RLS on `resignation_letters`.
- Allow anon + authenticated CRUD because this is a single-tenant no-auth app.
- All data is intentionally public/shared (no sign-in screen).
*/

CREATE TABLE IF NOT EXISTS resignation_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_name text NOT NULL,
  company text NOT NULL,
  last_day text NOT NULL,
  reason text,
  tone text NOT NULL,
  letter_text text,
  paid boolean NOT NULL DEFAULT false,
  payment_intent_id text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE resignation_letters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_letters" ON resignation_letters;
CREATE POLICY "anon_select_letters" ON resignation_letters FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_letters" ON resignation_letters;
CREATE POLICY "anon_insert_letters" ON resignation_letters FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_letters" ON resignation_letters;
CREATE POLICY "anon_update_letters" ON resignation_letters FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_letters" ON resignation_letters;
CREATE POLICY "anon_delete_letters" ON resignation_letters FOR DELETE
  TO anon, authenticated USING (true);
