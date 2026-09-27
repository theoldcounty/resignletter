# ResignLetter

ResignLetter collects resignation details, starts a server-hosted Stripe Checkout, verifies the returned payment with Stripe, and releases the letter only after verification. The active application is the Express server in `server/` with the React interface in `src/`.

## Run and check

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
```

The Replit **Start application** workflow runs `npm run dev`. Browser tests use a mocked Stripe checkout and return. A passing test suite does not by itself prove that a real payment or AI letter has been delivered.

## Payment configuration

Set the following **Configurations** for the environment being run. The project's `.replit` file currently sets `STRIPE_MODE=test` in both development and production, so neither environment should take live payments without an intentional mode change and republish.

| Configuration | Purpose |
| --- | --- |
| `STRIPE_MODE` | `test` (Sandbox) or `live`. The same value is embedded into the frontend build and enforced by the server on checkout, return, and webhook requests. |
| `STRIPE_TEST_PRICE_ID` | Stripe Price used only for Sandbox checkout and verification. |
| `STRIPE_LIVE_PRICE_ID` | Stripe Price used only for Live checkout and verification. |
| `GA_MEASUREMENT_ID` | Public GA4 measurement ID used only after analytics consent. |

Add the following as **Replit Secrets**, never as code or committed `.env` values:

| Secret | Purpose |
| --- | --- |
| `STRIPE_TEST_SECRET_KEY` | Server-side Stripe SDK key (`sk_test_`) for Sandbox. |
| `STRIPE_LIVE_SECRET_KEY` | Server-side Stripe SDK key (`sk_live_`) for Live. A value beginning `mk_` cannot be used for this server-hosted Checkout integration. |
| `STRIPE_TEST_PUBLISHABLE_KEY`, `STRIPE_LIVE_PUBLISHABLE_KEY` | Public Stripe.js keys. They can remain stored as Secrets, but this server-hosted redirect flow does **not** use Stripe.js or need them for checkout. |
| `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_LIVE_WEBHOOK_SECRET` | Matching signing secret for `/api/stripe/webhook`, needed for asynchronous payment updates. |
| `OPENAI_API_KEY` | Needed to generate the letter after verified payment. Without it, the return page offers a retryable setup error. |
| `GA4_API_SECRET` | Optional server-side purchase/failure analytics. |

Replit provides Secrets to the running server as environment variables; it does **not** create a committed `.env` file. `.env` files are ignored by Git. Public Stripe and analytics identifiers are recorded in [docs/public-identifiers.md](docs/public-identifiers.md).

## Checkout journey and safe rollout

1. In Sandbox (`STRIPE_MODE=test`), submit a valid form. The server selects `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_PRICE_ID`, persists a pending letter, and returns a Stripe-hosted Checkout URL.
2. After a successful test payment, Stripe returns to this app with a session and letter ID. The server checks the stored letter, Stripe session, payment status, mode, and configured price before marking it paid.
3. After payment is verified, the app requests a letter. This step requires `OPENAI_API_KEY`; failed verification or generation leaves the return link available for retry. Cancellation returns to the form without marking it paid.
4. Configure the webhook URL and signing secret for the selected mode to receive asynchronous payment updates. Test the full Sandbox payment and return before switching modes.
5. Only when Live is intended: set `STRIPE_MODE=live` for the deployment, add a valid rotated `sk_live_` key, confirm its Live Price belongs to that account, and publish the Autoscale app again. Never test a Live payment as part of automated checks.

The previously published static site may still serve an older build until the Autoscale server deployment is published. Pushing GitHub changes does not publish the site.