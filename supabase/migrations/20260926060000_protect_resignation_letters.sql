-- The original no-auth policies exposed every letter and allowed clients to mark
-- themselves paid. All letter access now goes through payment-verified Edge Functions.
DROP POLICY IF EXISTS "anon_select_letters" ON public.resignation_letters;
DROP POLICY IF EXISTS "anon_insert_letters" ON public.resignation_letters;
DROP POLICY IF EXISTS "anon_update_letters" ON public.resignation_letters;
DROP POLICY IF EXISTS "anon_delete_letters" ON public.resignation_letters;

ALTER TABLE public.resignation_letters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.resignation_letters FROM anon, authenticated;