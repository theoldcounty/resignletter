# ResignLetter public configuration

These are public reference identifiers supplied by the project owner. They are **not** Stripe secret keys. Verify the IDs against the intended Stripe account before accepting payments, especially in Live mode.

| Environment | Stripe account | Product | Price | Publishable key |
| --- | --- | --- | --- | --- |
| Sandbox | `acct_1Toj72DzN5HHmyCz` | `prod_VKfpjG7mnoKNGn` | `price_1UK0TaDzN5HHmyCzvFmo6OnO` | `pk_test_51Toj72DzN5HHmyCzsxWG9FGgMhYj1xUwuLjluoAKJHrranQzYObmLX5D3wFh4QGFGX0H9c6WccRpZMnUa5qsUTIH00jovDO6SV` |
| Live | `acct_1Toj6tDxbiVZ2Mt3` | `prod_VKfpjG7mnoKNGn` | `price_1UK0rsDxbiVZ2Mt3tD1cqfbe` | `pk_live_51Toj6tDxbiVZ2Mt3cxmauP54wNLVdeCtc3aAOBoxpWBuEXxHBQKOqn6q8fqH4wLofDDPIDbfmSansvfUVqh1nOFG00K6xqAJnx` |

Server-hosted Stripe Checkout does not currently need the publishable keys in the browser. They are recorded only as public reference values.

## Site and analytics

- Published URL: https://resignletter-rplk.replit.app/
- Project reference: RPLK
- Google Analytics measurement ID: `G-HF4121ZYTH`
- Google Analytics property ID: `556028987`
- Google Analytics stream ID: `15850571793`
- Google Analytics stream URL: https://resignletter-rplk.replit.app/

## Private configuration

Secret values are deliberately **not** in this document, the repository, or an `.env` file. Replit Secrets expose values to the server as environment variables at runtime without committing them to GitHub. The relevant names are `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_WEBHOOK_SECRET`, and `OPENAI_API_KEY`. Development and production Secrets must be configured separately.

Any secret posted in chat must be rotated before use. The owner-provided Live value began with `mk_`, which is not the `sk_live_` secret key this Checkout integration requires; do not use it as a live Checkout key.