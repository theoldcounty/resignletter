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

type Store = typeof defaultStorage;
type Dependencies = {
  store?: Store;
  getStripeClient?: (mode: StripeMode) => Promise<Stripe>;
  getCredentials?: typeof getStripeCredentials;
  processStripeWebhook?: (payload: Buffer, signature: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function paymentIntentId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id;
  return null;
}

async function sendPaymentAnalytics(
  status: 'paid' | 'failed' | 'expired',
  mode: StripeMode,
  metadata: Record<string, string | undefined>,
  object: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<boolean> {
  const clientId = metadata.ga_client_id;
  const secret = env.GA4_API_SECRET;
  const measurementId = env.GA_MEASUREMENT_ID;
  if (!clientId || !/^[0-9]+\.[0-9]+$/.test(clientId) || !secret ||
      !measurementId || !/^G-[A-Z0-9]+$/.test(measurementId)) return false;
  const name = status === 'paid' ? 'purchase' : status === 'failed' ? 'payment_failed' : 'checkout_expired';
  const params: Record<string, unknown> = { payment_mode: mode, payment_status: status };
  if (status === 'paid') {
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

async function createLetterWithAI(
  record: NonNullable<Awaited<ReturnType<Store['getLetter']>>>,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<{ letter: string } | { error: string; status: number }> {
  if (!env.OPENAI_API_KEY) return { error: 'AI service is not configured.', status: 503 as const };
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
  if (!response.ok) return { error: 'Letter generation failed. Please retry.', status: 502 as const };
  try {
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const letter = JSON.parse(data.choices?.[0]?.message?.content ?? '{}').letter;
    if (typeof letter !== 'string' || !letter.trim()) {
      return { error: 'Letter generation returned no content. Please retry.', status: 502 as const };
    }
    return { letter: letter.trim() };
  } catch {
    return { error: 'Letter generation returned invalid content. Please retry.', status: 502 as const };
  }
}

export function createApp(dependencies: Dependencies = {}): Express {
  const app = express();
  const store = dependencies.store ?? defaultStorage;
  const env = dependencies.env ?? process.env;
  const getClient = dependencies.getStripeClient ?? getUncachableStripeClient;
  const getCredentials = dependencies.getCredentials ?? getStripeCredentials;
  const fetcher = dependencies.fetcher ?? fetch;
  const processWebhook = dependencies.processStripeWebhook ?? (async (payload: Buffer, signature: string) => {
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);
  });

  // Stripe requires the unparsed bytes; this route must stay ahead of express.json().
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signatureHeader = req.headers['stripe-signature'];
    if (!signatureHeader || Array.isArray(signatureHeader)) {
      return res.status(400).json({ error: 'Missing Stripe signature.' });
    }
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Invalid Stripe payload.' });

    const configuredMode = stripeModeFromEnvironment(env);
    if (!configuredMode) return res.status(503).json({ error: 'Payment environment is not configured correctly.' });
    let stripe: Stripe;
    let credentials;
    try {
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
      event = stripe.webhooks.constructEvent(req.body, signatureHeader, credentials.webhookSecret);
    } catch {
      return res.status(400).json({ error: 'Invalid Stripe signature or event payload.' });
    }
    const mode: StripeMode = event.livemode ? 'live' : 'test';
    if (mode !== configuredMode) return res.status(400).json({ error: 'Stripe event mode does not match server configuration.' });

    try {
      await processWebhook(req.body, signatureHeader);
      const object = event.data.object as unknown as Record<string, unknown>;
      const status = paymentStatusForStripeEvent(
        event.type,
        typeof object.payment_status === 'string' ? object.payment_status : undefined,
      );
      const metadata = object.metadata as Record<string, string | undefined> | null;
      const letterId = metadata?.letter_id;
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
      const analyticsSent = updated
        ? await sendPaymentAnalytics(status, mode, metadata ?? {}, object, env, fetcher)
        : false;
      if (updated && status === 'paid') {
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

  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/api/checkout', async (req, res) => {
    const { mode } = req.body ?? {};
    if (!isStripeMode(mode)) return res.status(400).json({ error: 'Invalid payment environment.' });
    const configuredMode = stripeModeFromEnvironment(env);
    if (!configuredMode) return res.status(503).json({ error: 'Payment environment is not configured correctly.' });
    if (mode !== configuredMode) return res.status(409).json({ error: 'Checkout is not available in this payment environment.' });
    const form = parseLetterInput(req.body?.form);
    if (!form) return res.status(400).json({ error: 'Please check the letter details and try again.' });
    const origin = appOrigin(env);
    if (!origin) return res.status(503).json({ error: 'The app return URL is not configured.' });
    let priceId: string;
    try {
      priceId = stripePriceId(mode, env);
    } catch {
      return res.status(503).json({
        error: `${mode === 'test' ? 'STRIPE_TEST_PRICE_ID' : 'STRIPE_LIVE_PRICE_ID'} is not configured correctly.`,
      });
    }
    if (!env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'Letter generation is not configured. Please try later; no payment was taken.' });
    }
    if (mode === 'live' && !env.STRIPE_LIVE_WEBHOOK_SECRET?.startsWith('whsec_')) {
      return res.status(503).json({ error: 'Live webhook signing is not configured. Please try later; no payment was taken.' });
    }

    let stripe: Stripe;
    try {
      stripe = await getClient(mode);
    } catch {
      return res.status(503).json({
        error: mode === 'test'
          ? 'Stripe Sandbox is not configured correctly. Check STRIPE_TEST_SECRET_KEY is a valid sk_test_ key in Replit Secrets.'
          : 'Stripe Live is not configured correctly. Check STRIPE_LIVE_SECRET_KEY is a valid sk_live_ key in Replit Secrets.',
      });
    }
    const gaClientId = typeof req.body?.gaClientId === 'string' &&
      /^[0-9]+\.[0-9]+$/.test(req.body.gaClientId) && req.body.gaClientId.length <= 100
      ? req.body.gaClientId
      : undefined;

    try {
      const letterId = await store.createPendingLetter(form, mode, gaClientId, priceId);
      const session = await stripe.checkout.sessions.create(checkoutSessionParams(origin, letterId, mode, gaClientId, env));
      if (!session.id || !session.url) return res.status(502).json({ error: 'Stripe did not provide a checkout link.' });
      if (!await store.setCheckoutSession(letterId, session.id)) {
        return res.status(500).json({ error: 'Could not save checkout details. Please try again.' });
      }
      return res.json({ url: session.url, mode });
    } catch {
      return res.status(502).json({ error: 'Payment setup failed. Please try again.' });
    }
  });

  async function verifyPayment(
    letterId: unknown,
    sessionId: unknown,
    mode: unknown,
  ): Promise<{ verified: true; mode: StripeMode; paymentIntentId: string | null } | { error: string; status: number }> {
    if (!isStripeMode(mode) || typeof letterId !== 'string' || !UUID.test(letterId) ||
      typeof sessionId !== 'string' || !sessionId.startsWith('cs_') || sessionId.length > 255) {
      return { error: 'A valid paid checkout is required.', status: 400 as const };
    }
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
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      return { error: 'Payment could not be verified. Please retry.', status: 502 as const };
    }
    const expectedPriceId = record.stripe_price_id || session.metadata?.stripe_price_id;
    if (!expectedPriceId || !/^price_[A-Za-z0-9_]+$/.test(expectedPriceId) ||
      !isVerifiedCheckoutSession(session, letterId, sessionId, mode, env, expectedPriceId)) {
      return { error: 'Payment could not be verified.', status: 402 as const };
    }
    try {
      const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });
      if (items.has_more || items.data.length !== 1 ||
        items.data[0].price?.id !== expectedPriceId || items.data[0].quantity !== 1) {
        return { error: 'Payment price could not be verified.', status: 402 as const };
      }
    } catch {
      return { error: 'Payment price could not be verified. Please retry.', status: 502 as const };
    }
    const intentId = paymentIntentId(session.payment_intent);
    if (record.payment_status !== 'refund_pending' && record.payment_status !== 'refunded' &&
      !await store.recordPaid(letterId, sessionId, mode, intentId)) {
      return { error: 'Payment could not be recorded. Please retry.', status: 409 as const };
    }
    return { verified: true as const, mode, paymentIntentId: intentId };
  }

  async function refundFailedLetter(
    letterId: string,
    sessionId: string,
    mode: StripeMode,
    intentId: string | null,
    requireUnreturned = false,
  ): Promise<{ error: string; refundStatus: 'refunded' | 'pending' | 'unconfirmed' }> {
    const current = await store.getLetter(letterId);
    if (current?.payment_status === 'refunded') {
      return { error: 'We could not create your letter. Refund confirmed by Stripe; it may take several business days to appear on your card.', refundStatus: 'refunded' };
    }
    if (!await store.claimRefund(letterId, sessionId, mode, requireUnreturned)) {
      return { error: 'We could not create your letter. The refund could not be confirmed. Please check again or contact support before paying again.', refundStatus: 'unconfirmed' };
    }
    const paymentIntent = intentId || current?.stripe_payment_intent_id;
    if (!paymentIntent) {
      console.warn('A paid letter needs manual refund resolution because no payment intent is available.');
      return { error: 'We could not create your letter. The refund could not be confirmed. Please contact support before paying again.', refundStatus: 'unconfirmed' };
    }
    try {
      const stripe = await getClient(mode);
      const existing = await stripe.refunds.list({ payment_intent: paymentIntent, limit: 100 });
      const related = existing.data.filter((refund) => refund.metadata?.letter_id === letterId);
      const prior = related.find((refund) => refund.status === 'succeeded') ??
        related.find((refund) => refund.status === 'pending' || refund.status === 'requires_action');
      const refund = prior ?? await stripe.refunds.create(
        { payment_intent: paymentIntent, reason: 'requested_by_customer', metadata: { letter_id: letterId, reason: 'letter_generation_failed' } },
        { idempotencyKey: `letter-generation-${letterId}${related.length ? `-retry-${related.length}` : ''}` },
      );
      if (refund.status === 'succeeded') {
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
    return { error: 'We could not create your letter. The refund could not be confirmed. Check its status here or contact support before paying again.', refundStatus: 'unconfirmed' };
  }

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

  async function deliverLetter(
    letterId: unknown,
    sessionId: unknown,
    mode: unknown,
    fromCustomer = false,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      const verification = await verifyPayment(letterId, sessionId, mode);
      if ('error' in verification) return { status: verification.status, body: { error: verification.error } };
      const id = letterId as string;
      const session = sessionId as string;
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
      if (record.letter_text) return { status: 200, body: letterResponse(record) };

      let generated: Awaited<ReturnType<typeof createLetterWithAI>>;
      try {
        generated = await createLetterWithAI(record, env, fetcher);
      } catch {
        generated = { error: 'Letter generation failed.', status: 502 };
      }
      if ('error' in generated) {
        return { status: 503, body: await refundFailedLetter(id, session, verification.mode, verification.paymentIntentId) };
      }
      if (!await store.saveLetterText(id, generated.letter)) {
        const latest = await store.getLetter(id);
        if (!latest?.letter_text || latest.payment_status !== 'paid') {
          return { status: 503, body: await refundFailedLetter(id, session, verification.mode, verification.paymentIntentId) };
        }
        return { status: 200, body: letterResponse(latest) };
      }
      const saved = await store.getLetter(id);
      if (!saved?.letter_text) return { status: 500, body: { error: 'The letter was saved but could not be retrieved. Please retry.' } };
      return { status: 200, body: letterResponse(saved) };
    } catch {
      return { status: 500, body: { error: 'Could not prepare your letter. Please retry.' } };
    }
  }

  let reconciling = false;
  app.locals.reconcileOutstanding = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const rows = await store.claimOutstanding();
      const configuredMode = stripeModeFromEnvironment(env);
      await Promise.all(rows.map(async (row) => {
        if (row.payment_mode !== configuredMode) return;
        if (!row.return_seen_at) {
          const verification = await verifyPayment(row.id, row.stripe_session_id, row.payment_mode);
          if ('error' in verification) {
            if (verification.status >= 500) console.warn('An outstanding checkout could not be checked; it will retry.');
            return;
          }
          const latest = await store.getLetter(row.id);
          if (latest?.return_seen_at) {
            await deliverLetter(row.id, row.stripe_session_id, row.payment_mode);
            return;
          }
          if (!latest || latest.letter_text || !Number.isFinite(Date.parse(row.created_at))) return;
          if (latest.payment_status === 'refund_pending' ||
            Date.now() - Date.parse(row.created_at) >= 10 * 60_000) {
            const refund = await refundFailedLetter(row.id, row.stripe_session_id, row.payment_mode, verification.paymentIntentId, true);
            if (refund.refundStatus === 'unconfirmed') {
              const returned = await store.getLetter(row.id);
              if (returned?.return_seen_at) {
                await deliverLetter(row.id, row.stripe_session_id, row.payment_mode);
              } else {
                console.warn('An unreturned paid checkout needs refund resolution.');
              }
            }
          }
          return;
        }
        const result = await deliverLetter(row.id, row.stripe_session_id, row.payment_mode);
        if (result.status >= 500 && result.body.refundStatus !== 'refunded') {
          console.warn('An outstanding paid letter needs another fulfillment or refund check.');
        }
      }));
    } finally {
      reconciling = false;
    }
  };

  app.post('/api/generate-letter', async (req, res) => {
    const { status, body } = await deliverLetter(req.body?.letterId, req.body?.sessionId, req.body?.mode, true);
    return res.status(status).json(body);
  });

  return app;
}