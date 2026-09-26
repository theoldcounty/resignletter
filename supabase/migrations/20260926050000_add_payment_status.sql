ALTER TABLE public.resignation_letters
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending';

UPDATE public.resignation_letters
SET payment_status = CASE WHEN paid THEN 'paid' ELSE 'pending' END
WHERE payment_status = 'pending' AND paid = true;

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