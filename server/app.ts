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
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an HR advisor. Write a professional resignation letter. Include a formal greeting, clear resignation, last working day, brief thanks, and offer to help transition. Keep it under 250 words and match the requested tone. Return ONLY valid JSON: {"letter":"full text here"}.',
        },
        {
          role: 'user',
          content: `Manager: ${record.manager_name}\nCompany: ${record.company}\nLast Day: ${record.last_day}\nReason: ${record.reason || 'Not provided'}\nTone: ${record.tone}`,
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
    try {
      stripePriceId(mode, env);
    } catch {
      return res.status(503).json({
        error: `${mode === 'test' ? 'STRIPE_TEST_PRICE_ID' : 'STRIPE_LIVE_PRICE_ID'} is not configured correctly.`,
      });
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
      const letterId = await store.createPendingLetter(form, mode, gaClientId);
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
  ): Promise<{ verified: true; mode: StripeMode } | { error: string; status: number }> {
    if (!isStripeMode(mode) || typeof letterId !== 'string' || !UUID.test(letterId) ||
      typeof sessionId !== 'string' || !sessionId.startsWith('cs_') || sessionId.length > 255) {
      return { error: 'A valid paid checkout is required.', status: 400 as const };
    }
    const configuredMode = stripeModeFromEnvironment(env);
    if (!configuredMode) return { error: 'Payment environment is not configured correctly.', status: 503 as const };
    if (mode !== configuredMode) return { error: 'Payment is not available in this environment.', status: 409 as const };
    try {
      stripePriceId(mode, env);
    } catch {
      return {
        error: `${mode === 'test' ? 'STRIPE_TEST_PRICE_ID' : 'STRIPE_LIVE_PRICE_ID'} is not configured correctly.`,
        status: 503 as const,
      };
    }
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
    if (!isVerifiedCheckoutSession(session, letterId, sessionId, mode, env)) {
      return { error: 'Payment could not be verified.', status: 402 as const };
    }
    if (!await store.recordPaid(letterId, sessionId, mode, paymentIntentId(session.payment_intent))) {
      return { error: 'Payment could not be recorded. Please retry.', status: 409 as const };
    }
    return { verified: true as const, mode };
  }

  app.post('/api/verify-payment', async (req, res) => {
    try {
      const result = await verifyPayment(req.body?.letterId, req.body?.sessionId, req.body?.mode);
      if ('error' in result) return res.status(result.status).json({ error: result.error });
      return res.json(result);
    } catch {
      return res.status(500).json({ error: 'Payment could not be verified. Please retry.' });
    }
  });

  app.post('/api/generate-letter', async (req, res) => {
    const { letterId, sessionId, mode } = req.body ?? {};
    try {
      const verification = await verifyPayment(letterId, sessionId, mode);
      if ('error' in verification) return res.status(verification.status).json({ error: verification.error });
      const record = await store.getLetter(letterId);
      if (!record || record.payment_status !== 'paid') {
        return res.status(409).json({ error: 'Payment has not been recorded yet. Please retry.' });
      }
      if (record.letter_text) return res.json({ letter: record.letter_text });

      const generated = await createLetterWithAI(record, env, fetcher);
      if ('error' in generated) return res.status(generated.status).json({ error: generated.error });
      if (!await store.saveLetterText(letterId, generated.letter)) {
        const latest = await store.getLetter(letterId);
        if (!latest?.letter_text || latest.payment_status !== 'paid') {
          return res.status(500).json({ error: 'Could not save your letter. Please retry.' });
        }
        return res.json({ letter: latest.letter_text });
      }
      return res.json({ letter: generated.letter });
    } catch {
      return res.status(500).json({ error: 'Could not prepare your letter. Please retry.' });
    }
  });

  return app;
}