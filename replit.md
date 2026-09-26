# Running this project on Replit

## Start the app

- The `Start application` workflow runs `npm run dev` on port 5000.
- Vite is configured to listen on `0.0.0.0:5000` and allow Replit's proxied hosts.
- For a production build, run `npm run build`.

## Supabase configuration

Set these Replit Secrets before using the app:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

The frontend uses a Supabase project for the `resignation_letters` table and calls the `generate-letter` and `create-checkout` Edge Functions. Apply every migration in `supabase/migrations/` and deploy the functions to the same Supabase project.

The Stripe mode defaults to test. The checkout Edge Function expects these secrets in Supabase Edge Function settings:

- `OPENAI_API_KEY`
- `STRIPE_TEST_SECRET_KEY`
- `STRIPE_LIVE_SECRET_KEY` (only if live payments are enabled)
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_TEST_WEBHOOK_SECRET`
- `STRIPE_LIVE_WEBHOOK_SECRET` (only if live webhooks are enabled)
- `GA4_API_SECRET` (needed for server-side purchase/failure events)

Never put Stripe secret keys in source files, `.env`, or GitHub. The test/live product and price IDs are public identifiers in `supabase/functions/_shared/payment.ts`; the Google Analytics measurement ID is in `index.html`.

The app includes a Google Analytics consent choice. Page views and interaction events are sent only after the visitor allows analytics; names, company names, and letter text are not sent.

The Replit preview serves the frontend; it does not run the Supabase Edge Functions locally. Checkout verification, payment status webhooks, and letter generation require the deployed Supabase functions and database migrations. Configure Stripe test and live webhook endpoints to call the `stripe-webhook` Edge Function and send `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, and `payment_intent.payment_failed`.