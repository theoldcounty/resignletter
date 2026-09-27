# Running this project on Replit

## Start the app

The `Start application` workflow runs `npm run dev` on port 5000. One Express process serves the same-origin `/api` routes and the Vite frontend. `npm run build` builds the frontend; `npm run start` serves that build with the API in production.

## Payment and letter setup

Public Stripe account, product, price, publishable-key, and analytics identifiers are recorded in `docs/public-identifiers.md`. Secret values are never stored there.

The owner selects the environment with the Replit Configuration `STRIPE_MODE=test` (badge **Sandbox**) or `STRIPE_MODE=live` (badge **Live**). Vite embeds this same value in the frontend build, while the server reads it at runtime and rejects mismatched checkout and return requests. Visitors cannot switch modes. Development is configured as `test` and production as `live`; the published Autoscale server stays on its previous build until the owner republishes. Live checkout does not require webhooks; the app restricts checkout to synchronous card payments.

Add a rotated Stripe sandbox secret key as the Replit Secret `STRIPE_TEST_SECRET_KEY` for sandbox checkout. A Stripe connector is **not required**: the server reads the Secret directly through the Stripe SDK. For live checkout, use a separate valid `sk_live_` value in `STRIPE_LIVE_SECRET_KEY`; an `mk_` value is not a live Checkout secret. The `STRIPE_TEST_PRICE_ID` and `STRIPE_LIVE_PRICE_ID` Configurations determine the corresponding prices, and the server verifies the selected price on return. Publishable keys stored in Secrets are not needed by this server-hosted Checkout flow. Never put secret keys in the frontend or repository.

The private `resignation_letters` table is defined in `server/schema.sql` and applied to the Replit development PostgreSQL database. Existing development tables can be upgraded with `server/migrations/20260927_letter_delivery.sql` (already applied in this workspace); do not manually run it on the managed production database. The app never exposes the table to browser queries. Replit Publish transfers development schema changes to the managed production database. `stripe-replit-sync` owns the separate Stripe schema; application code does not create its own Stripe catalog tables.

Webhooks are not configured or required for the selected card-only checkout. The return page verifies payment directly with Stripe. The optional `/api/stripe/webhook` endpoint accepts only signed events if the owner configures matching signing secrets later; do not point Stripe at this endpoint without setting the correct secret.

Set `OPENAI_API_KEY` as a Replit Secret for AI letter delivery after verified payment. New checkout is blocked when it is absent, so the app cannot knowingly charge without a generator. If generation fails after a verified payment, the app requests a full idempotent Stripe refund and distinguishes confirmed, pending, and unconfirmed states. It never fabricates a letter or claims a refund Stripe has not confirmed. Generated letters store their generation date; the sender's name is required, addresses are optional, and downloads include TXT and print-ready A4 PDF. `GA_MEASUREMENT_ID` is a public Configuration for consented browser analytics; optionally set `GA4_API_SECRET` as a Replit Secret for server-side purchase/failure analytics. Set `APP_BASE_URL` to the trusted HTTPS origin when needed; otherwise the server uses its Replit runtime domain for Stripe return and webhook URLs. Confirm production Secrets separately before publishing.

Never put Stripe or AI secret keys in source files, `.env`, or GitHub. Rotate any key pasted into a chat or document. The app's Google Analytics consent choice sends page views and interactions only after permission; names, company details, letter text, and Stripe/letter identifiers are excluded from analytics.

## Publishing

The published site is now a server deployment on Autoscale. The chosen flow is form → Stripe card payment → verified return → AI letter. No webhook or timed no-return refund is used. If a paid buyer never returns, no letter is generated and no automatic refund is requested; if they later use their private return link, the server verifies payment before delivery. After a verified return, interrupted letter generation and its refund handling can be retried while the Autoscale server is running. Review paid no-return purchases manually in Stripe. Verify a real Sandbox checkout, return, and AI delivery, and confirm the Live key was rotated before republishing. The live site stays on its current build until the owner republishes.

The old `supabase/` functions and migrations are no longer called by the app; they remain as historical source. Existing Supabase letter data was not copied or deleted during this backend change.