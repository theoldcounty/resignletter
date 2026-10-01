/**
 * Express API boundary for checkout, payment verification, and letter delivery.
 * Stripe, OpenAI, and PostgreSQL stay server-side; request fields are untrusted,
 * and Stripe must confirm payment before any protected fulfillment step.
 * Adapters can be replaced in tests without changing the production routes.
 */
import express, { type Express } from 'express';
import type Stripe from 'stripe';
import { getStripeCredentials, getStripeSync, getUncachableStripeClient } from './stripeClient';
import {
  appOrigin,
  checkoutSessionParams,
  isStripeMode,
  isVerifiedCheckoutSession,
  parseLetterInput,
  paymentStatusForStripeEvent,
  stripeModeFromEnvironment,
  stripePriceId,
  type StripeMode,
} from './payment';
import { storage as defaultStorage } from './storage';

// Derive the storage contract from its implementation so tests can inject a
// lightweight store while production uses the PostgreSQL adapter.
type Store = typeof defaultStorage;

// Optional adapters isolate external services and process state from route
// logic; omitted dependencies resolve to the real production implementations.
type Dependencies = {
  store?: Store;
  getStripeClient?: (mode: StripeMode) => Promise<Stripe>;
  getCredentials?: typeof getStripeCredentials;
  processStripeWebhook?: (payload: Buffer, signature: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
};

// IDs from the browser are untrusted: enforce the database UUID shape before
// using them to locate a letter or accept Stripe metadata.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accept both Stripe's expanded PaymentIntent object and its string ID form. */
function paymentIntentId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id;
  return null;
}

/**
 * Send a minimal server-side GA4 event after a Stripe payment outcome.
 * Analytics is best-effort and must never determine whether fulfillment works.
 */
async function sendPaymentAnalytics(
  status: 'paid' | 'failed' | 'expired',
  mode: StripeMode,
  metadata: Record<string, string | undefined>,
  object: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<boolean> {
  // GA4 Measurement Protocol requires all three values; omit reporting rather
  // than sending an event with a malformed or incomplete identifier.
  const clientId = metadata.ga_client_id;
  const secret = env.GA4_API_SECRET;
  const measurementId = env.GA_MEASUREMENT_ID;
  if (!clientId || !/^[0-9]+\.[0-9]+$/.test(clientId) || !secret ||
      !measurementId || !/^G-[A-Z0-9]+$/.test(measurementId)) return false;
  const name = status === 'paid' ? 'purchase' : status === 'failed' ? 'payment_failed' : 'checkout_expired';
  // Common fields identify the transaction state without sending letter text
  // or other user-entered personal details to the analytics provider.
  const params: Record<string, unknown> = { payment_mode: mode, payment_status: status };
  if (status === 'paid') {
    // Stripe amounts use the smallest currency unit; GA4 expects major units.
    const amount = typeof object.amount_total === 'number'
      ? object.amount_total
      : typeof object.amount === 'number' ? object.amount : undefined;
    if (amount !== undefined && Number.isFinite(amount) && amount >= 0) params.value = amount / 100;
    if (typeof object.currency === 'string' && /^[a-z]{3}$/i.test(object.currency)) {
      params.currency = object.currency.toUpperCase();
    }
    if (metadata.stripe_product_id) {
      params.items = [{ item_id: metadata.stripe_product_id, quantity: 1 }];
    }
  }
  try {
    // The Measurement Protocol secret is server-only and URL-encoded because
    // GA4 expects it as a query parameter.
    const response = await fetcher(
      `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${encodeURIComponent(secret)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, events: [{ name, params }] }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Generate letter text only after the caller verifies paid status.
 * The OpenAI key remains server-side, and JSON mode plus validation make the
 * model response suitable for storage as application data.
 */
async function createLetterWithAI(
  record: NonNullable<Awaited<ReturnType<Store['getLetter']>>>,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<{ letter: string } | { error: string; status: number }> {
  // Fail before calling OpenAI so an unavailable service enters the explicit
  // retry/refund path instead of wasting time on an impossible request.
  if (!env.OPENAI_API_KEY) return { error: 'AI service is not configured.', status: 503 as const };
  // Bound the upstream request so slow model responses cannot hold a request
  // open indefinitely; the fulfillment reconciler can retry a later attempt.
  // Use the server-side REST endpoint through the injected fetcher so provider
  // calls are testable without exposing the OpenAI credential to the browser.
  const response = await fetcher('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an HR advisor. Write a professional resignation letter. Include a formal greeting, clear resignation, last working day, brief thanks, offer to help transition, and a closing signed with the sender name. Keep it under 250 words and match the requested tone. Do not include a date or any address blocks; the app formats those separately. Return ONLY valid JSON: {"letter":"full text here"}.',
        },
        {
          role: 'user',
          content: `Sender: ${record.sender_name || 'Employee'}\nManager: ${record.manager_name}\nCompany: ${record.company}\nLast Day: ${record.last_day}\nReason: ${record.reason || 'Not provided'}\nTone: ${record.tone}`,
        },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  // Hide provider response bodies and internal details behind an application
  // error; callers receive a safe retryable status instead.
  if (!response.ok) return { error: 'Letter generation failed. Please retry.', status: 502 as const };
  try {
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const letter = JSON.parse(data.choices?.[0]?.message?.content ?? '{}').letter;
    // Treat absent or blank output as failed fulfillment; never save an empty
    // document or return success when the model did not produce a letter.
    if (typeof letter !== 'string' || !letter.trim()) {
      return { error: 'Letter generation returned no content. Please retry.', status: 502 as const };
    }
    return { letter: letter.trim() };
  } catch {
    return { error: 'Letter generation returned invalid content. Please retry.', status: 502 as const };
  }
}

/** Compose routes and bind production adapters or test doubles in one place. */
export function createApp(dependencies: Dependencies = {}): Express {
  const app = express();
  // Resolve adapters once per app instance to keep tests isolated and avoid
  // coupling route handlers to external-service constructors.
  const store = dependencies.store ?? defaultStorage;
  const env = dependencies.env ?? process.env;
  const getClient = dependencies.getStripeClient ?? getUncachableStripeClient;
  const getCredentials = dependencies.getCredentials ?? getStripeCredentials;
  const fetcher = dependencies.fetcher ?? fetch;
  // stripe-replit-sync persists verified Stripe event data; this app also
  // applies each supported event to its own letter/payment record.
  const processWebhook = dependencies.processStripeWebhook ?? (async (payload: Buffer, signature: string) => {
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);
  });

  /**
   * POST /api/stripe/webhook — Stripe sends the original signed event bytes.
   * Keep this route before express.json(), because parsing changes those bytes.
   */
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signatureHeader = req.headers['stripe-signature'];
    // A present header is not proof of trust; require exactly one value before
    // passing it to Stripe's signature verifier.
    if (!signatureHeader || Array.isArray(signatureHeader)) {
      return res.status(400).json({ error: 'Missing Stripe signature.' });
    }
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Invalid Stripe payload.' });

    // Only load credentials for the server-selected environment; an incoming
    // event cannot switch this process between test and live Stripe accounts.
    const configuredMode = stripeModeFromEnvironment(env);
    if (!configuredMode) return res.status(503).json({ error: 'Payment environment is not configured correctly.' });
    let stripe: Stripe;
    let credentials;
    try {
      // Resolve the API client and signing secret together so missing settings
      // fail closed before any event is processed.
      [stripe, credentials] = await Promise.all([
        getClient(configuredMode),
        getCredentials(configuredMode),
      ]);
    } catch {
      return res.status(503).json({ error: 'Stripe is not configured for this payment mode.' });
    }
    if (!credentials.webhookSecret) return res.status(503).json({ error: 'Stripe webhook is not configured.' });

    let event: Stripe.Event;
    try {
      // Stripe verifies the HMAC against the original bytes and configured
      // secret; parsed JSON or metadata alone cannot prove that payment occurred.
      event = stripe.webhooks.constructEvent(req.body, signatureHeader, credentials.webhookSecret);
    } catch {
      return res.status(400).json({ error: 'Invalid Stripe signature or event payload.' });
    }
    // Also match the signed event's mode to server configuration, preventing a
    // valid event from the wrong Stripe account from changing an order.
    const mode: StripeMode = event.livemode ? 'live' : 'test';
    if (mode !== configuredMode) return res.status(400).json({ error: 'Stripe event mode does not match server configuration.' });

    try {
      // Let Stripe Sync persist Stripe's event records, then map supported
      // event types to this application's narrower payment states.
      await processWebhook(req.body, signatureHeader);
      const object = event.data.object as unknown as Record<string, unknown>;
      const status = paymentStatusForStripeEvent(
        event.type,
        typeof object.payment_status === 'string' ? object.payment_status : undefined,
      );
      const metadata = object.metadata as Record<string, string | undefined> | null;
      const letterId = metadata?.letter_id;
      // Ignore authenticated events that do not identify a supported order;
      // never apply arbitrary or malformed metadata to a database row.
      if (!status || !letterId || metadata?.stripe_mode !== mode || !UUID.test(letterId)) {
        return res.json({ received: true, processed: false });
      }
      const sessionId = event.type.startsWith('checkout.session.') && typeof object.id === 'string'
        ? object.id
        : null;
      const intentId = event.type.startsWith('payment_intent.')
        ? typeof object.id === 'string' ? object.id : null
        : paymentIntentId(object.payment_intent);
      const updated = await store.applyWebhookStatus(letterId, mode, status, sessionId, intentId);
      // Count analytics only when the matching row accepted this event, so
      // duplicate deliveries and stale transitions are not double-reported.
      const analyticsSent = updated
        ? await sendPaymentAnalytics(status, mode, metadata ?? {}, object, env, fetcher)
        : false;
      if (updated && status === 'paid') {
        // Customers may close the browser before returning from Checkout.
        // Queue recovery without delaying Stripe's webhook acknowledgement.
        setImmediate(() => {
          void (app.locals.reconcileOutstanding as () => Promise<void>)()
            .catch(() => console.warn('Paid webhook fulfillment check failed; it will retry.'));
        });
      }
      return res.json({ received: true, processed: updated, status: updated ? status : undefined, analyticsSent });
    } catch {
      return res.status(500).json({ error: 'Could not process Stripe webhook.' });
    }
  });

  // Parse only small application requests; the webhook above intentionally
  // retains its raw body for signature verification.
  app.use(express.json({ limit: '32kb' }));

  /** Liveness endpoint for deployment monitors; it exposes no service details. */
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  /**
   * POST /api/checkout — accepts { mode, form, gaClientId } and returns a
   * Stripe-hosted checkout URL. The browser can request payment but cannot
   * choose a price or use checkout creation as proof of later payment.
   */
  app.post('/api/checkout', async (req, res) => {
    // Treat the body as client-controlled and restrict its requested mode to
    // the environment selected by the server.
    const { mode } = req.body ?? {};
    if (!isStripeMode(mode)) return res.status(400).json({ error: 'Invalid payment environment.' });
    const configuredMode = stripeModeFromEnvironment(env);
    if (!configuredMode) return res.status(503).json({ error: 'Payment environment is not configured correctly.' });
    if (mode !== configuredMode) return res.status(409).json({ error: 'Checkout is not available in this payment environment.' });
    // Normalize and validate the form before personal data is stored or sent
    // to the letter-generation provider.
    const form = parseLetterInput(req.body?.form);
    if (!form) return res.status(400).json({ error: 'Please check the letter details and try again.' });
    // Use only the server's trusted HTTPS origin for hosted-checkout redirects;
    // accepting a browser-supplied URL could create an open redirect.
    const origin = appOrigin(env);
    if (!origin) return res.status(503).json({ error: 'The app return URL is not configured.' });
    // Resolve the catalog price from server configuration; a client-supplied
    // price ID must never control the amount charged.
    let priceId: string;
    try {
      priceId = stripePriceId(mode, env);
    } catch {
      return res.status(503).json({
        error: `${mode === 'test' ? 'STRIPE_TEST_PRICE_ID' : 'STRIPE_LIVE_PRICE_ID'} is not configured correctly.`,
      });
    }
    // Do not collect payment when the server cannot attempt fulfillment.
    if (!env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'Letter generation is not configured. Please try later; no payment was taken.' });
    }

    let stripe: Stripe;
    try {
      // The Stripe SDK uses a server-only key to create Checkout; card details
      // are collected by Stripe and never pass through this application.
      stripe = await getClient(mode);
    } catch {
      return res.status(503).json({
        error: mode === 'test'
          ? 'Stripe Sandbox is not configured correctly. Check STRIPE_TEST_SECRET_KEY is a valid sk_test_ key in Replit Secrets.'
          : 'Stripe Live is not configured correctly. Check STRIPE_LIVE_SECRET_KEY is a valid sk_live_ key in Replit Secrets.',
      });
    }
    // This optional value is only for conversion analytics; it does not
    // authorize an order. Bound and validate it before storing in metadata.
    const gaClientId = typeof req.body?.gaClientId === 'string' &&
      /^[0-9]+\.[0-9]+$/.test(req.body.gaClientId) && req.body.gaClientId.length <= 100
      ? req.body.gaClientId
      : undefined;

    try {
      // Save a pending order first so Checkout has a durable application ID
      // that can be matched to signed webhooks if the browser closes.
      const letterId = await store.createPendingLetter(form, mode, gaClientId, priceId);
      // Compose price, metadata, and return URLs on the server. Hosted Checkout
      // keeps sensitive card handling outside this app.
      const session = await stripe.checkout.sessions.create(checkoutSessionParams(origin, letterId, mode, gaClientId, env));
      if (!session.id || !session.url) return res.status(502).json({ error: 'Stripe did not provide a checkout link.' });
      if (!await store.setCheckoutSession(letterId, session.id)) {
        return res.status(500).json({ error: 'Could not save checkout details. Please try again.' });
      }
      // Return only Stripe's hosted URL and public mode; later requests must
      // submit references that the server verifies against Stripe.
      return res.json({ url: session.url, mode });
    } catch {
      return res.status(502).json({ error: 'Payment setup failed. Please try again.' });
    }
  });

  /**
   * Verify the submitted order against Stripe's API, not browser claims.
   * Both the verification and fulfillment routes reuse this trust boundary.
   */
  async function verifyPayment(
    letterId: unknown,
    sessionId: unknown,
    mode: unknown,
  ): Promise<{ verified: true; mode: StripeMode; paymentIntentId: string | null } | { error: string; status: number }> {
    // Validate formats before database or provider lookups; references locate
    // the order but do not attest that its customer paid.
    if (!isStripeMode(mode) || typeof letterId !== 'string' || !UUID.test(letterId) ||
      typeof sessionId !== 'string' || !sessionId.startsWith('cs_') || sessionId.length > 255) {
      return { error: 'A valid paid checkout is required.', status: 400 as const };
    }
    // Bind the order to the server-selected Stripe account and the Checkout
    // session originally saved for this specific letter.
    const configuredMode = stripeModeFromEnvironment(env);
    if (!configuredMode) return { error: 'Payment environment is not configured correctly.', status: 503 as const };
    if (mode !== configuredMode) return { error: 'Payment is not available in this environment.', status: 409 as const };
    const record = await store.getLetter(letterId);
    if (!record || record.payment_mode !== mode || record.stripe_session_id !== sessionId) {
      return { error: 'Letter or checkout session not found.', status: 404 as const };
    }
    let stripe: Stripe;
    try {
      stripe = await getClient(mode);
    } catch {
      return {
        error: 'Stripe is not configured for this payment mode. Please retry after payment setup is complete.',
        status: 503 as const,
      };
    }
    let session: Stripe.Checkout.Session;
    try {
      // Retrieve authoritative payment state with the server's Stripe client;
      // a return URL or client-provided status is not enough to grant access.
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      return { error: 'Payment could not be verified. Please retry.', status: 502 as const };
    }
    // Prefer the price recorded before Checkout was created; metadata is a
    // compatibility fallback and is still checked against the retrieved session.
    const expectedPriceId = record.stripe_price_id || session.metadata?.stripe_price_id;
    if (!expectedPriceId || !/^price_[A-Za-z0-9_]+$/.test(expectedPriceId) ||
      !isVerifiedCheckoutSession(session, letterId, sessionId, mode, env, expectedPriceId)) {
      return { error: 'Payment could not be verified.', status: 402 as const };
    }
    try {
      // Confirm the actual purchase line, not only session metadata, and require
      // exactly one unit of the expected server-selected price.
      const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });
      if (items.has_more || items.data.length !== 1 ||
        items.data[0].price?.id !== expectedPriceId || items.data[0].quantity !== 1) {
        return { error: 'Payment price could not be verified.', status: 402 as const };
      }
    } catch {
      return { error: 'Payment price could not be verified. Please retry.', status: 502 as const };
    }
    const intentId = paymentIntentId(session.payment_intent);
    // Persist verified payment before fulfillment; a late session return must
    // not move an order out of a terminal refund state.
    if (record.payment_status !== 'refund_pending' && record.payment_status !== 'refunded' &&
      !await store.recordPaid(letterId, sessionId, mode, intentId)) {
      return { error: 'Payment could not be recorded. Please retry.', status: 409 as const };
    }
    return { verified: true as const, mode, paymentIntentId: intentId };
  }

  /**
   * Confirm or retry a refund when a paid letter cannot be delivered.
   * A storage claim coordinates workers, and Stripe idempotency protects a
   * retry when the provider accepted a request before the first call timed out.
   */
  async function refundFailedLetter(
    letterId: string,
    sessionId: string,
    mode: StripeMode,
    intentId: string | null,
  ): Promise<{ error: string; refundStatus: 'refunded' | 'pending' | 'unconfirmed' }> {
    const current = await store.getLetter(letterId);
    // This state was recorded only after Stripe confirmed success, so it is
    // safe to report without issuing another refund request.
    if (current?.payment_status === 'refunded') {
      return { error: 'We could not create your letter. Refund confirmed by Stripe; it may take several business days to appear on your card.', refundStatus: 'refunded' };
    }
    // Reserve refund handling before calling Stripe so webhooks, browser
    // retries, and background reconciliation cannot race into separate refunds.
    if (!await store.claimRefund(letterId, sessionId, mode)) {
      return { error: 'We could not create your letter. The refund could not be confirmed. Please check again or contact support before paying again.', refundStatus: 'unconfirmed' };
    }
    // Prefer the intent from the fresh verification; use persisted state if
    // that response did not include one.
    const paymentIntent = intentId || current?.stripe_payment_intent_id;
    if (!paymentIntent) {
      console.warn('A paid letter needs manual refund resolution because no payment intent is available.');
      return { error: 'We could not create your letter. The refund could not be confirmed. Please contact support before paying again.', refundStatus: 'unconfirmed' };
    }
    try {
      const stripe = await getClient(mode);
      // Reuse a matching successful or pending refund after ambiguous retries;
      // create a new request only if Stripe has no prior attempt for this order.
      const existing = await stripe.refunds.list({ payment_intent: paymentIntent, limit: 100 });
      const related = existing.data.filter((refund) => refund.metadata?.letter_id === letterId);
      const prior = related.find((refund) => refund.status === 'succeeded') ??
        related.find((refund) => refund.status === 'pending' || refund.status === 'requires_action');
      const refund = prior ?? await stripe.refunds.create(
        { payment_intent: paymentIntent, reason: 'requested_by_customer', metadata: { letter_id: letterId, reason: 'letter_generation_failed' } },
        { idempotencyKey: `letter-generation-${letterId}${related.length ? `-retry-${related.length}` : ''}` },
      );
      if (refund.status === 'succeeded') {
        // Stripe is authoritative for refund completion. Persist the terminal
        // state so later returns do not request another refund.
        if (!await store.markRefunded(letterId, sessionId, mode) &&
          (await store.getLetter(letterId))?.payment_status !== 'refunded') {
          console.warn('Stripe confirmed a refund but the local refund state could not be saved; it will retry.');
        }
        return { error: 'We could not create your letter. Refund confirmed by Stripe; it may take several business days to appear on your card.', refundStatus: 'refunded' };
      }
      if (refund.status === 'pending') {
        return { error: 'We could not create your letter. Stripe accepted a refund request, but the refund is still pending. Check its status here before paying again.', refundStatus: 'pending' };
      }
    } catch {
      // Never describe a refund as confirmed when Stripe did not confirm it.
    }
    // Treat provider errors and all other statuses as unconfirmed, not as a
    // completed refund, so the customer gets an accurate next step.
    return { error: 'We could not create your letter. The refund could not be confirmed. Check its status here or contact support before paying again.', refundStatus: 'unconfirmed' };
  }

  /** Shape a stored order into the stable document payload consumed by the UI. */
  function letterResponse(record: NonNullable<Awaited<ReturnType<Store['getLetter']>>>) {
    return {
      letter: record.letter_text,
      details: {
        senderName: record.sender_name || '',
        homeAddress: record.home_address,
        officeAddress: record.office_address,
        generatedAt: record.letter_generated_at,
      },
    };
  }

  /**
   * POST /api/verify-payment — accepts { letterId, sessionId, mode } and checks
   * the current Stripe session, then returns { verified, mode }. It never
   * returns letter text, so this route alone cannot disclose the document.
   */
  app.post('/api/verify-payment', async (req, res) => {
    try {
      const result = await verifyPayment(req.body?.letterId, req.body?.sessionId, req.body?.mode);
      if ('error' in result) return res.status(result.status).json({ error: result.error });
      await store.markReturnSeen(req.body.letterId, req.body.sessionId, result.mode);
      return res.json({ verified: true, mode: result.mode });
    } catch {
      return res.status(500).json({ error: 'Payment could not be verified. Please retry.' });
    }
  });

  /**
   * Shared fulfillment path for customer requests and background recovery.
   * Every entry verifies Stripe before reading or generating protected text.
   */
  async function deliverLetter(
    letterId: unknown,
    sessionId: unknown,
    mode: unknown,
    fromCustomer = false,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      // Recheck Stripe even on internal retries; no earlier request or stored
      // browser claim is treated as permanent proof of payment.
      const verification = await verifyPayment(letterId, sessionId, mode);
      if ('error' in verification) return { status: verification.status, body: { error: verification.error } };
      const id = letterId as string;
      const session = sessionId as string;
      // A real customer return opts the order into recovery. Webhook-only and
      // abandoned sessions do not trigger unsolicited generation or refunds.
      if (fromCustomer) await store.markReturnSeen(id, session, verification.mode);
      const record = await store.getLetter(id);
      if (!record) {
        return { status: 409, body: { error: 'Payment has not been recorded yet. Please retry.' } };
      }
      if (record.payment_status === 'refunded' || record.payment_status === 'refund_pending') {
        return { status: 503, body: await refundFailedLetter(id, session, verification.mode, verification.paymentIntentId) };
      }
      if (record.payment_status !== 'paid') {
        return { status: 409, body: { error: 'Payment has not been recorded yet. Please retry.' } };
      }
      // Saved text is the idempotent result: refreshes return the same document
      // without another model call or another charge.
      if (record.letter_text) return { status: 200, body: letterResponse(record) };

      let generated: Awaited<ReturnType<typeof createLetterWithAI>>;
      try {
        // Only paid, non-refunded orders reach OpenAI; the submitted personal
        // details are sent only to fulfill the requested letter.
        generated = await createLetterWithAI(record, env, fetcher);
      } catch {
        generated = { error: 'Letter generation failed.', status: 502 };
      }
      if ('error' in generated) {
        return { status: 503, body: await refundFailedLetter(id, session, verification.mode, verification.paymentIntentId) };
      }
      // Save only while the order remains paid and text is absent. If another
      // request won the same race, reuse its committed result instead.
      if (!await store.saveLetterText(id, generated.letter)) {
        const latest = await store.getLetter(id);
        if (!latest?.letter_text || latest.payment_status !== 'paid') {
          return { status: 503, body: await refundFailedLetter(id, session, verification.mode, verification.paymentIntentId) };
        }
        return { status: 200, body: letterResponse(latest) };
      }
      // Read back the committed database value so the response reflects durable
      // storage rather than only this request's in-memory model output.
      const saved = await store.getLetter(id);
      if (!saved?.letter_text) return { status: 500, body: { error: 'The letter was saved but could not be retrieved. Please retry.' } };
      return { status: 200, body: letterResponse(saved) };
    } catch {
      return { status: 500, body: { error: 'Could not prepare your letter. Please retry.' } };
    }
  }

  // Avoid overlapping passes in this process; the database also locks row
  // claims so separate server instances coordinate the same pending work.
  let reconciling = false;
  app.locals.reconcileOutstanding = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      // Claim a bounded, rate-limited batch atomically, then process each order
      // independently so one failure does not block other paid customers.
      const rows = await store.claimOutstanding();
      const configuredMode = stripeModeFromEnvironment(env);
      await Promise.all(rows.map(async (row) => {
        // Only resume journeys that reached the app after Stripe's paid return.
        // Never generate or refund merely because a checkout was created.
        if (row.payment_mode !== configuredMode || !row.return_seen_at) return;
        const result = await deliverLetter(row.id, row.stripe_session_id, row.payment_mode);
        if (result.status >= 500 && result.body.refundStatus !== 'refunded') {
          console.warn('An outstanding paid letter needs another fulfillment or refund check.');
        }
      }));
    } finally {
      reconciling = false;
    }
  };

  /**
   * POST /api/generate-letter — accepts { letterId, sessionId, mode } and
   * returns { letter, details } only after payment is verified. The caller
   * cannot provide letter text or bypass generation/refund safeguards.
   */
  app.post('/api/generate-letter', async (req, res) => {
    const { status, body } = await deliverLetter(req.body?.letterId, req.body?.sessionId, req.body?.mode, true);
    return res.status(status).json(body);
  });

  // The executable entry point adds Vite/static serving and starts the listener;
  // returning the configured app also lets tests exercise routes in isolation.
  return app;
}