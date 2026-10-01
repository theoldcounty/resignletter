-- Historical hardening step for the Supabase-backed flow. The current Express
-- app does not use this migration path; this file's presence does not confirm
-- that it was applied.
--
-- The initial policies exposed every letter and let clients mark themselves
-- paid. Remove those named public policies, then revoke direct table grants
-- from anon/authenticated client roles. The old Edge Functions expected trusted
-- server-side database work to use the service-role path.
-- This migration is not, by itself, evidence that an Edge Function is deployed.
DROP POLICY IF EXISTS "anon_select_letters" ON public.resignation_letters;
DROP POLICY IF EXISTS "anon_insert_letters" ON public.resignation_letters;
DROP POLICY IF EXISTS "anon_update_letters" ON public.resignation_letters;
DROP POLICY IF EXISTS "anon_delete_letters" ON public.resignation_letters;

-- Keep row-level security on even after removing the public policies.
ALTER TABLE public.resignation_letters ENABLE ROW LEVEL SECURITY;

-- RLS policies alone do not remove SQL privileges granted directly to roles.
REVOKE ALL ON public.resignation_letters FROM anon, authenticated;