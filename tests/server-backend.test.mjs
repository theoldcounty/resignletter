import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { getStripeCredentials, stripeKeyMatchesMode } from '../server/stripeClient.ts';

const letterId = '123e4567-e89b-42d3-a456-426614174000';
const sessionId = 'cs_test_example';
const validForm = {
  managerName: 'Morgan Manager',
  company: 'Example Co',
  lastDay: '2026-10-30',
  reason: 'A new opportunity',
  tone: 'professional',
};
const env = {
  STRIPE_MODE: 'test',
  STRIPE_TEST_PRICE_ID: 'price_1UK0TaDzN5HHmyCzvFmo6OnO',
  STRIPE_LIVE_PRICE_ID: 'price_1UK0rsDxbiVZ2Mt3tD1cqfbe',
  APP_BASE_URL: 'https://letters.example/path',
};

function createStore(overrides = {}) {
  const record = {
    id: letterId,
    manager_name: validForm.managerName,
    company: validForm.company,
    last_day: validForm.lastDay,
    reason: validForm.reason,
    tone: validForm.tone,
    payment_mode: 'test',
    payment_status: 'pending',
    stripe_session_id: sessionId,
    letter_text: null,
  };
  return {
    record,
    createPendingLetter: async () => letterId,
    setCheckoutSession: async () => true,
    getLetter: async () => record,
    recordPaid: async () => {
      record.payment_status = 'paid';
      return true;
    },
    applyWebhookStatus: async () => true,
    saveLetterText: async (_id, text) => {
      record.letter_text = text;
      return true;
    },
    ...overrides,
  };
}

async function withApp(app, callback) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('checkout enforces configured mode and rejects invalid form before Stripe', async () => {
  let stripeCalls = 0;
  const app = createApp({
    env,
    store: createStore(),
    getStripeClient: async () => {
      stripeCalls += 1;
      return {};
    },
  });

  await withApp(app, async (base) => {
    const mismatch = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'live', form: validForm }),
    });
    assert.equal(mismatch.status, 409);
    const invalid = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'test', form: { ...validForm, lastDay: '2026-02-30' } }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(stripeCalls, 0);
  });
});

test('Stripe credential key prefixes must agree with payment mode', () => {
  assert.equal(stripeKeyMatchesMode('sk_test_fake', 'test'), true);
  assert.equal(stripeKeyMatchesMode('sk_live_fake', 'test'), false);
  assert.equal(stripeKeyMatchesMode('sk_live_fake', 'live'), true);
});

test('a sandbox key in Replit Secrets works without a Stripe connector', async () => {
  const credentials = await getStripeCredentials('test', {
    STRIPE_TEST_SECRET_KEY: 'sk_test_example',
    STRIPE_TEST_WEBHOOK_SECRET: 'whsec_example',
  });
  assert.equal(credentials.secretKey, 'sk_test_example');
  assert.equal(credentials.webhookSecret, 'whsec_example');
  await assert.rejects(getStripeCredentials('test', {}), /not configured/);
  await assert.rejects(
    getStripeCredentials('test', { STRIPE_TEST_SECRET_KEY: 'sk_live_wrong_mode' }),
    /does not match/,
  );
});

test('sandbox and live clients use only their corresponding configured secrets', async () => {
  const configured = {
    STRIPE_TEST_SECRET_KEY: 'sk_test_example',
    STRIPE_LIVE_SECRET_KEY: 'sk_live_example',
  };
  assert.equal((await getStripeCredentials('test', configured)).secretKey, 'sk_test_example');
  assert.equal((await getStripeCredentials('live', configured)).secretKey, 'sk_live_example');
  await assert.rejects(
    getStripeCredentials('live', { STRIPE_TEST_SECRET_KEY: 'sk_test_example' }),
    /not configured/,
  );
});

test('live checkout uses the live configured price and rejects sandbox requests', async () => {
  const liveEnv = {
    ...env,
    STRIPE_MODE: 'live',
    STRIPE_TEST_PRICE_ID: 'price_test_configured',
    STRIPE_LIVE_PRICE_ID: 'price_live_configured',
  };
  const modes = [];
  const store = createStore({
    createPendingLetter: async (_form, mode) => {
      modes.push(mode);
      return letterId;
    },
  });
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          assert.equal(params.line_items[0].price, 'price_live_configured');
          assert.equal(params.metadata.stripe_price_id, 'price_live_configured');
          assert.match(params.success_url, /mode=live/);
          return { id: 'cs_live_example', url: 'https://checkout.stripe.test/live' };
        },
      },
    },
  };
  const app = createApp({
    env: liveEnv,
    store,
    getStripeClient: async (mode) => {
      assert.equal(mode, 'live');
      return stripe;
    },
  });

  await withApp(app, async (base) => {
    const post = (mode) => fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, form: validForm }),
    });
    assert.equal((await post('test')).status, 409);
    const response = await post('live');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mode, 'live');
  });
  assert.deepEqual(modes, ['live']);
});

test('checkout ignores forged payment fields and uses trusted letter data', async () => {
  let inserted;
  const store = createStore({
    createPendingLetter: async (form, mode, gaClientId) => {
      inserted = { form, mode, gaClientId };
      return letterId;
    },
  });
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          assert.equal(params.line_items[0].price, 'price_1UK0TaDzN5HHmyCzvFmo6OnO');
          assert.equal(params.success_url.startsWith('https://letters.example/'), true);
          return { id: sessionId, url: 'https://checkout.stripe.test/session' };
        },
      },
    },
  };
  const app = createApp({ env, store, getStripeClient: async () => stripe });

  await withApp(app, async (base) => {
    const response = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'test',
        form: { ...validForm, paid: true, payment_status: 'paid', letter_text: 'Forged' },
        paid: true,
        gaClientId: 'invalid-client',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(inserted, { form: validForm, mode: 'test', gaClientId: undefined });
  });
});

test('missing Stripe key gives Preview an explicit 503', async () => {
  const app = createApp({
    env,
    store: createStore(),
    getStripeClient: async () => { throw new Error('not connected'); },
  });
  await withApp(app, async (base) => {
    const response = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'test', form: validForm }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /STRIPE_TEST_SECRET_KEY/);
  });
});

test('payment verification requires a returned paid session and can be retried', async () => {
  let paid = false;
  let retrieveCount = 0;
  const store = createStore();
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          assert.equal(id, sessionId);
          retrieveCount += 1;
          return {
            id,
            metadata: {
              letter_id: letterId,
              stripe_mode: 'test',
              stripe_price_id: 'price_1UK0TaDzN5HHmyCzvFmo6OnO',
            },
            payment_status: paid ? 'paid' : 'unpaid',
            livemode: false,
            payment_intent: 'pi_test_example',
          };
        },
      },
    },
  };
  const app = createApp({ env, store, getStripeClient: async () => stripe });

  await withApp(app, async (base) => {
    const post = () => fetch(`${base}/api/verify-payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ letterId, sessionId, mode: 'test' }),
    });
    const failed = await post();
    assert.equal(failed.status, 402);
    paid = true;
    const retry = await post();
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).verified, true);
    assert.equal(retrieveCount, 2);
    assert.equal(store.record.payment_status, 'paid');
  });
});

test('webhook requires a signature and rejects invalid signed payloads', async () => {
  const stripe = { webhooks: { constructEvent: () => { throw new Error('invalid'); } } };
  const app = createApp({
    env,
    store: createStore(),
    getStripeClient: async () => stripe,
    getCredentials: async () => ({ secretKey: 'test-key', webhookSecret: 'fake-webhook-secret' }),
  });
  await withApp(app, async (base) => {
    const missing = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 400);
    const invalid = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'fake' },
      body: '{}',
    });
    assert.equal(invalid.status, 400);
  });
});