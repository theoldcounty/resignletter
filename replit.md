# Running this project on Replit

## Start the app

The `Start application` workflow runs `npm run dev` on port 5000. One Express process serves the same-origin `/api` routes and the Vite frontend. `npm run build` builds the frontend; `npm run start` serves that build with the API in production.

## Payment and letter setup

Public Stripe account, product, price, publishable-key, and analytics identifiers are recorded in `docs/public-identifiers.md`. Secret values are never stored there.

The owner selects the environment with the Replit Configuration `STRIPE_MODE=test` (default, badge **Sandbox**) or `STRIPE_MODE=live` (badge **Live**). Vite embeds this same value in the frontend build, while the server reads it at runtime and rejects mismatched checkout and return requests. Visitors cannot switch modes. Both development and production are currently configured as `test`; publish again after intentionally changing production to `live`.

Add a rotated Stripe sandbox secret key as the Replit Secret `STRIPE_TEST_SECRET_KEY` for sandbox checkout. A Stripe connector is **not required**: the server reads the Secret directly through the Stripe SDK. For live checkout, use a separate valid `sk_live_` value in `STRIPE_LIVE_SECRET_KEY`; an `mk_` value is not a live Checkout secret. The `STRIPE_TEST_PRICE_ID` and `STRIPE_LIVE_PRICE_ID` Configurations determine the corresponding prices, and the server verifies the selected price on return. Publishable keys stored in Secrets are not needed by this server-hosted Checkout flow. Never put secret keys in the frontend or repository.

The private `resignation_letters` table is defined in `server/schema.sql` and applied to the Replit development PostgreSQL database. The app never exposes it to browser queries. Replit Publish transfers development schema changes to the managed production database. `stripe-replit-sync` owns the separate Stripe schema; application code does not create its own Stripe catalog tables.

For webhook delivery, configure the Stripe endpoint at the trusted HTTPS app origin's `/api/stripe/webhook` path and store its signing secret in `STRIPE_TEST_WEBHOOK_SECRET` (or `STRIPE_LIVE_WEBHOOK_SECRET` for live). Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, and `payment_intent.payment_failed`. The endpoint verifies Stripe's signature on the raw body. The return page verifies synchronous card payments directly with Stripe even before the webhook is configured, but asynchronous payment updates require a working webhook.

Set `OPENAI_API_KEY` as a Replit Secret for AI letter delivery after verified payment. Until it exists, a paid return shows an explicit retryable configuration error; it never fabricates a letter. `GA_MEASUREMENT_ID` is a public Configuration for consented browser analytics; optionally set `GA4_API_SECRET` as a Replit Secret for server-side purchase/failure analytics. Set `APP_BASE_URL` to the trusted HTTPS origin when needed; otherwise the server uses its Replit runtime domain for Stripe return and webhook URLs. Confirm production Secrets separately before publishing.

Never put Stripe or AI secret keys in source files, `.env`, or GitHub. Rotate any key pasted into a chat or document. The app's Google Analytics consent choice sends page views and interactions only after permission; names, company details, letter text, and Stripe/letter identifiers are excluded from analytics.

## Publishing

The next publish must use the configured Autoscale server deployment, not the old static deployment. The previously published static site will continue serving its older build until the owner republishes. Do not publish a payment-ready claim until a real Stripe Sandbox checkout, return, webhook, and AI delivery have been verified with the configured account.

The old `supabase/` functions and migrations are no longer called by the app; they remain as historical source. Existing Supabase letter data was not copied or deleted during this backend change.