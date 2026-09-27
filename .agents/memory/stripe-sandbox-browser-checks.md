---
name: Stripe Sandbox browser checks
description: A checkout-hosted validation quirk that can obscure real Sandbox payment verification.
---

Stripe-hosted Sandbox Checkout may preselect an optional Link opt-in. When it does, a valid test card can still show only a generic “Required” error because the Link phone field is empty.

**Why:** A real browser payment test stalled despite valid card fields; inspecting the checkout's invalid fields identified the optional phone field. Unchecking Link allowed the Sandbox payment to return and verify successfully.

**How to apply:** During future real Sandbox browser checks, inspect the checkout's invalid fields and uncheck Link or supply a test phone before diagnosing the payment integration. Do not automate a Live charge.