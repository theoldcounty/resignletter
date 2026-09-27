# ResignLetter — version 2.0

## What it does

ResignLetter helps a visitor write a professional resignation letter. They enter their details, pay a one-off £1 through Stripe-hosted Checkout, and receive an AI-generated letter after the server verifies payment. They can copy the result or download a plain-text file or a print-ready A4 PDF. No account is required.

## How it works

### Customer journey

1. Enter a **required sender name**, manager, company, last working day, and tone (grateful, professional, or direct). A reason, home address, and office address are optional.
2. Accept the checkout terms and start a guest Stripe Checkout. The server stores the form and original Price ID before creating the Checkout Session.
3. On return, the server retrieves the session from Stripe. It checks the saved session, letter reference, payment mode, paid status, original Price ID, and the actual purchased line item before releasing anything. A cancelled or unverified checkout does not generate a letter.
4. The server requests the letter from OpenAI and saves the text and generation timestamp. The result displays the saved letter, with TXT and styled A4 PDF downloads. The date is the **generation date**, not the current download date; optional address blocks appear only when supplied.
5. If a verified payment cannot produce a letter, the server requests a full, idempotent Stripe refund. The customer sees whether Stripe confirmed it, it remains pending, or its status could not be confirmed. A refunded purchase cannot later generate a letter.
6. No webhook is required for checkout: the app offers synchronous card payments and verifies a returned session directly with Stripe. Only after a verified customer return does it generate the letter; an in-process check can finish a return interrupted during generation. If generation fails after return, an unconfirmed refund is retried and logged. **If someone pays but never returns, the app does not generate a letter or automatically request a refund.** The private return link can still be used later to verify the payment and retrieve the letter.

### Pricing

One-time **£1 GBP per letter**. No subscription, stored card, or account. Development uses Stripe Sandbox; the production configuration is set to Stripe Live. Publishing the server app enables real £1 card payments without a webhook. No Live payment or refund was performed during development verification.

## Features and enhancements in 2.0

- Three letter tones and a required sender name; optional home and office addresses are included only when provided.
- Print-ready A4 PDF with saved date and address layout, plus the original TXT download and copy action.
- Verified, mode-specific Stripe checkout with the purchased line item checked against the stored original Price ID; rotating a configured price does not strand earlier purchases.
- Persisted letters for retrying the return URL, including compatibility with older saved letters that have no recorded sender or generation date.
- In-process completion for a paid return interrupted during generation. No timed refund or generation occurs for a checkout with no observed return.
- Idempotent refund attempts that distinguish **confirmed**, **pending**, and **unconfirmed** Stripe outcomes.
- Consent-gated analytics. An optional, signature-verified webhook endpoint remains in the code but is not required or configured for checkout.
- ResignLetter-specific page title, description, canonical URL, social titles/descriptions, and favicon instead of starter assets.

## Site structure

This is a single-page React site backed by Express; there is no account dashboard.

| Surface | Purpose |
| --- | --- |
| `/` | Letter form, optional analytics consent, payment-mode indicator, and checkout button. |
| `/?session_id=…&letter_id=…&mode=…` | Stripe success return on the same page; verifies payment before displaying or downloading the letter. Do not share this private return URL. |
| `/?cancelled=…` | Cancelled checkout returns to the form without marking it paid. |
| `/api/health` | Server health response. |
| `/api/checkout` | Validates the form and configured environment, creates a saved pending letter and Stripe-hosted Checkout Session. |
| `/api/verify-payment`, `/api/generate-letter` | Verify the paid session and deliver or retrieve the saved letter. |
| `/api/stripe/webhook` | Optional raw-body, signature-checked Stripe event endpoint; unused without a signing secret. |

### Repository layout

```text
index.html                       Page metadata and consent-default bootstrap
public/favicon.svg               Site favicon
src/
  App.tsx                        Form, payment return, results, and downloads
  components/                    Analytics consent and payment-mode UI
  lib/                           Analytics, payment mode, letter text/PDF layout
server/
  app.ts                         Checkout, verification, generation, refunds, webhooks
  index.ts                       Express/Vite server and reconciliation timer
  payment.ts                     Input and payment validation
  storage.ts                     PostgreSQL persistence and state transitions
  stripeClient.ts                Mode-specific Stripe client and signing credentials
  schema.sql                     New development database schema
  migrations/                    Incremental schema update for an existing database
tests/                            Browser journey, payment, analytics, PDF, backend tests
docs/public-identifiers.md       Public Stripe and analytics configuration references
```

### Data schema

`public.resignation_letters` is the application-owned table in `server/schema.sql`. Stripe catalog and synchronized event tables, when enabled, belong to `stripe-replit-sync` and are **not** created or owned here.

| Group | Saved fields and purpose |
| --- | --- |
| Identity and form | UUID `id`; sender, manager, company, optional addresses and reason, last day, and tone. |
| Payment | Mode (`test` or `live`), status, unique Checkout Session ID, original Price ID, and PaymentIntent ID. |
| Delivery | Letter text, generation timestamp, return-seen timestamp, and most recent fulfillment-check timestamp. |
| Diagnostics | Optional consented GA client ID, creation time, and update time. No card details or OpenAI key are stored. |

The payment state can move from `pending` to `paid`, a failed/expired checkout, `refund_pending`, or `refunded`. Atomic database conditions stop a refunded letter from being saved. Without a webhook, a paid checkout is recorded in this table only when its private return link is used.

For a **new development database**, use `server/schema.sql`. For an existing development database created before the 2.0 fields, apply `server/migrations/20260927_letter_delivery.sql` once; this workspace's development database is already upgraded. Replit Publish transfers the development schema to its managed production database. Do not manually run the development migration against production. Old letters without a known sender or generation date remain retrievable without inventing either value.

## SEO and analytics

The homepage title, description, canonical URL, Open Graph text, and Twitter summary point to the existing published ResignLetter URL. No social preview image is claimed until a real brand image is supplied. If the production domain changes, update the canonical and Open Graph URLs in `index.html`.

The browser uses consent-gated Google Analytics 4. It does not send the sender name, letter text, addresses, or Checkout Session IDs as event parameters or page query strings. Client events cover the form, tone selection, checkout return, letter generation, copying/downloading, and failures. Webhook-based `purchase`, `payment_failed`, and `checkout_expired` Measurement Protocol events require a consented GA client ID and optional `GA4_API_SECRET`; event delivery has not been verified in GA4 itself. See `src/lib/analytics.ts` and `server/app.ts`.

## Technology and environment

React 18, TypeScript, Vite 5, Express, PostgreSQL, Stripe SDK/hosted Checkout, `stripe-replit-sync`, OpenAI chat completions, and pdfmake. Node/npm commands are used here, not the Bun/TanStack stack in the attached reference document.

The tracked `.replit` configuration has `STRIPE_MODE=test` in **development** and `STRIPE_MODE=live` in **production**. The frontend build and Express server use the same mode. `STRIPE_TEST_PRICE_ID`, `STRIPE_LIVE_PRICE_ID`, and `GA_MEASUREMENT_ID` are public configurations; public reference identifiers are in [docs/public-identifiers.md](docs/public-identifiers.md).

| Replit Secret | Purpose |
| --- | --- |
| `STRIPE_TEST_SECRET_KEY` | Sandbox server SDK key (`sk_test_`). |
| `STRIPE_LIVE_SECRET_KEY` | Live server SDK key (`sk_live_`); rotate any key previously exposed in chat. |
| `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_LIVE_WEBHOOK_SECRET` | Optional signing secrets (`whsec_`) if Stripe webhooks are configured later; neither is needed for Live card checkout. |
| `OPENAI_API_KEY` | Required to enable checkout; server-only letter generation. |
| `GA4_API_SECRET` | Optional consented GA4 Measurement Protocol events. |

Replit provides Secrets to the server at runtime; do **not** commit them or place them in a tracked `.env`. Hosted Checkout does not use the stored publishable keys or Stripe.js. Development and production secrets should be checked separately before release.

## Run and test

```sh
npm ci
npm run dev         # Replit "Start application" workflow, port 5000
npm test            # Browser tests use mocked Stripe checkout and return
npm run typecheck
npm run lint
npm run build
npm run start       # Built frontend + Express in production mode
```

The automated suite checks form validation, payment gating, mode and line-item verification, interrupted returns, refund retries and races, legacy downloads, PDF layout, and analytics consent. A real £1 **Sandbox** Checkout, OpenAI letter, TXT, and PDF were also checked in development; that does not prove the published or Live journey works. No automated check makes a Live charge.

## Known limitations and planned enhancements

- A buyer who loses the private return URL cannot independently recover a saved letter. A secure, short-lived recovery flow is a future enhancement; avoid public ID lookups.
- Refunds after a returned, paid purchase that cannot generate a letter are retried and logged while the server runs, but there is no dedicated operator alert yet. Add monitoring and a manual-resolution workflow for unconfirmed refunds.
- A customer who pays but closes Stripe before the return redirect receives no letter and no automatic refund. The private return link remains usable if they retained it. This no-return policy was chosen for the simplified checkout flow; review such payments manually in Stripe.
- PDF text is generated from the AI response and the known form fields; review the result before sending it to an employer.
- Add an owned social preview image and verify the production domain before updating sharing metadata.

## Publishing status and checklist

The published server is now on **Autoscale** (`npm run build` then `npm run start`). It is serving the previously published build until the owner republishes; a GitHub push alone does not update the live site. In this version, generation begins on verified return, not on a background timer for abandoned checkouts.

Before clicking Publish to enable real payments:

1. Confirm the currently configured Live key is a **rotated**, unexposed `sk_live_` key. A read-only Stripe call accepted a Live key and confirmed the configured price was an active one-time £1 GBP price; it cannot establish that the old exposed key was rotated.
2. Confirm the chosen no-return policy: if a paid customer never follows the success redirect, the app does not automatically deliver or refund that purchase. No webhooks are configured or needed for returned synchronous card payments.
3. Check the production OpenAI secret and database/schema setup, publish the **server** app, and verify the published health endpoint and return URLs. Publish transfers the development schema; do not apply the SQL migration by hand in production.
4. Confirm the actual Live payment, letter, and refund process under a separately authorized, controlled launch procedure. Do not infer Live success from Sandbox testing or perform an unrequested Live charge.

The development preview remains in Sandbox. Publishing the server app with the Live Stripe key begins accepting real £1 payments; GitHub pushes alone do not.