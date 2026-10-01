/*
 * Historical initial schema for the Supabase-backed flow; the active app is
 * served by Express and does not use this migration path.
 *
 * The broad anon/authenticated policies below record the original no-login
 * design only. The later protect_resignation_letters migration drops them and
 * revokes those roles' table privileges. Do not read this file alone as the
 * current security policy, or infer from its presence that it was deployed.
 *
 * Original table intent:
 * - `resignation_letters`
 *   - `id` (uuid, primary key)
 *   - `manager_name` (text, not null) — the recipient manager's name
 *   - `company` (text, not null) — the company name
 *   - `last_day` (text, not null) — the user's last working day
 *   - `reason` (text, nullable) — optional reason for resigning
 *   - `tone` (text, not null) — tone selection: grateful, professional, or direct
 *   - `letter_text` (text, nullable) — the generated letter content
 *   - `paid` (boolean, default false) — whether payment was completed
 *   - `payment_intent_id` (text, nullable) — Stripe payment intent ID
 *   - `created_at` (timestamptz, default now)
 *
 * Original security intent was to enable RLS while allowing public CRUD for a
 * single-tenant, no-login app. That policy was later recognized as too broad.
 */

-- One row holds the submitted form, payment state, and generated letter.
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

-- RLS gates table access by role/policy; the following historical policies
-- initially granted the public Supabase roles broad access.
ALTER TABLE resignation_letters ENABLE ROW LEVEL SECURITY;

-- Original public read policy: every anon/authenticated client could see every row.
DROP POLICY IF EXISTS "anon_select_letters" ON resignation_letters;
CREATE POLICY "anon_select_letters" ON resignation_letters FOR SELECT
  TO anon, authenticated USING (true);

-- Original public insert policy: no ownership constraint existed in this version.
DROP POLICY IF EXISTS "anon_insert_letters" ON resignation_letters;
CREATE POLICY "anon_insert_letters" ON resignation_letters FOR INSERT
  TO anon, authenticated WITH CHECK (true);

-- Original public update policy: clients could also change fields such as `paid`.
DROP POLICY IF EXISTS "anon_update_letters" ON resignation_letters;
CREATE POLICY "anon_update_letters" ON resignation_letters FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

-- Original public delete policy: any client could remove any letter.
DROP POLICY IF EXISTS "anon_delete_letters" ON resignation_letters;
CREATE POLICY "anon_delete_letters" ON resignation_letters FOR DELETE
  TO anon, authenticated USING (true);
