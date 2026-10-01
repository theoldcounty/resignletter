-- Historical Supabase migration; the active Express application does not use
-- this migration path, and this file's presence does not prove it was applied.
-- Adds a lifecycle value alongside the older `paid` boolean for the old
-- payment/webhook flow. The later protection migration tightens table access.

-- Keep the change rerunnable on databases where this migration may have partly run.
ALTER TABLE public.resignation_letters
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending';

-- Backfill only the default/pending rows: preserve any more specific status
-- that may already have been recorded while mapping legacy paid=true records.
UPDATE public.resignation_letters
SET payment_status = CASE WHEN paid THEN 'paid' ELSE 'pending' END
WHERE payment_status = 'pending' AND paid = true;

-- Avoid recreating the constraint when it already exists. The finite set keeps
-- webhook and checkout status values aligned with the database representation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'resignation_letters_payment_status_check'
  ) THEN
    ALTER TABLE public.resignation_letters
      ADD CONSTRAINT resignation_letters_payment_status_check
      CHECK (payment_status IN ('pending', 'paid', 'failed', 'cancelled', 'expired'));
  END IF;
END $$;