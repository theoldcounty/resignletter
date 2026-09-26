# Running this project on Replit

## Start the app

- The `Start application` workflow runs `npm run dev` on port 5000.
- Vite is configured to listen on `0.0.0.0:5000` and allow Replit's proxied hosts.
- For a production build, run `npm run build`.

## Supabase configuration

Set these Replit Secrets before using the app:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Checkout is disabled by default. Set `VITE_ENABLE_CHECKOUT=true` only after the security migration is applied, the Supabase functions are deployed, and a full Stripe test payment and letter delivery have been verified. Both frontend settings above are also required. For a static publish, Vite embeds these values during the build; after changing them, publish again so the live build receives them.

The frontend calls the `create-checkout` and `generate-letter` Supabase Edge Functions. Those functions use the service role to access the private `resignation_letters` table; visitors have no direct table access. Apply every migration in `supabase/migrations/` in order, including `20260926060000_protect_resignation_letters.sql`, and deploy `create-checkout`, `generate-letter`, and `stripe-webhook` to the same Supabase project. Do not publish a working payment flow before the security migration is applied.

The Stripe mode defaults to test. The checkout Edge Function expects these secrets in Supabase Edge Function settings:

- `OPENAI_API_KEY`
- `STRIPE_TEST_SECRET_KEY`
- `STRIPE_LIVE_SECRET_KEY` (only if live payments are enabled)
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_TEST_WEBHOOK_SECRET`
- `STRIPE_LIVE_WEBHOOK_SECRET` (only if live webhooks are enabled)
- `GA4_API_SECRET` (needed for server-side purchase/failure events)
- `APP_BASE_URL` (the trusted HTTPS app origin for Stripe return URLs; set it to the preview origin while testing, then the actual published origin after publishing)

Never put Stripe secret keys in source files, `.env`, or GitHub. The test/live product and price IDs are public identifiers in `supabase/functions/_shared/payment.ts`; the Google Analytics measurement ID is in `index.html`.

The app includes a Google Analytics consent choice. Page views and interaction events are sent only after the visitor allows analytics; names, company names, letter text, Stripe checkout/payment IDs, letter IDs, and raw query identifiers are not sent.

The Replit preview serves the frontend; it does not run the Supabase Edge Functions locally. Checkout verification, payment status webhooks, and letter generation require the deployed Supabase functions and database migrations. The Stripe webhook function is configured with JWT verification disabled so Stripe can deliver signed requests; the handler verifies the raw-body Stripe signature itself. Configure Stripe test and live webhook endpoints to call the `stripe-webhook` Edge Function and send `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, and `payment_intent.payment_failed`.