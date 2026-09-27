import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { getStripeCredentials, stripeKeyMatchesMode } from '../server/stripeClient.ts';
import { parseLetterInput } from '../server/payment.ts';

const letterId = '123e4567-e89b-42d3-a456-426614174000';
const sessionId = 'cs_test_example';
const validForm = {
  senderName: 'Taylor Employee',
  managerName: 'Morgan Manager',
  company: 'Example Co',
  lastDay: '2026-10-30',
  reason: 'A new opportunity',
  tone: 'professional',
  homeAddress: '12 Sample Road\nLondon',
  officeAddress: 'Office House\nLondon',
};
const env = {
  STRIPE_MODE: 'test',
  STRIPE_TEST_PRICE_ID: 'price_1UK0TaDzN5HHmyCzvFmo6OnO',
  STRIPE_LIVE_PRICE_ID: 'price_1UK0rsDxbiVZ2Mt3tD1cqfbe',
  APP_BASE_URL: 'https://letters.example/path',
  OPENAI_API_KEY: 'test-only-key',
};

const lineItems = (priceId = env.STRIPE_TEST_PRICE_ID) => ({
  data: [{ price: { id: priceId }, quantity: 1 }],
  has_more: false,
});

function createStore(overrides = {}) {
  const record = {
    id: letterId,
    sender_name: validForm.senderName,
    manager_name: validForm.managerName,
    company: validForm.company,
    home_address: validForm.homeAddress,
    office_address: validForm.officeAddress,
    letter_generated_at: null,
    return_seen_at: null,
    last_day: validForm.lastDay,
    reason: validForm.reason,
    tone: validForm.tone,
    payment_mode: 'test',
    payment_status: 'pending',
    stripe_session_id: sessionId,
    stripe_price_id: env.STRIPE_TEST_PRICE_ID,
    letter_text: null,
  };
  return {
    record,
    createPendingLetter: async () => letterId,
    setCheckoutSession: async () => true,
    getLetter: async () => record,
    recordPaid: async () => {
      if (!['pending', 'paid'].includes(record.payment_status)) return false;
      record.payment_status = 'paid';
      return true;
    },
    markReturnSeen: async () => {
      if (record.payment_status !== 'paid') return false;
      record.return_seen_at = '2026-09-27T12:00:00Z';
      return true;
    },
    applyWebhookStatus: async () => true,
    saveLetterText: async (_id, text) => {
      if (record.payment_status !== 'paid' || record.letter_text) return false;
      record.letter_text = text;
      record.letter_generated_at = '2026-09-27T12:00:00Z';
      return true;
    },
    claimRefund: async (_id, _session, _mode, requireUnreturned = false) => {
      if (requireUnreturned && record.return_seen_at) return false;
      if (record.payment_status === 'paid' && !record.letter_text) record.payment_status = 'refund_pending';
      return record.payment_status === 'refund_pending';
    },
    markRefunded: async () => {
      if (record.payment_status !== 'refund_pending') return false;
      record.payment_status = 'refunded';
      return true;
    },
    claimOutstanding: async () => [],
    ...overrides,
  };
}

test('requires the sender name and preserves only supplied optional addresses', () => {
  assert.equal(parseLetterInput({ ...validForm, senderName: '' }), null);
  assert.equal(parseLetterInput({ ...validForm, homeAddress: 'x'.repeat(501) }), null);
  const parsed = parseLetterInput({
    ...validForm,
    senderName: '  Taylor Employee  ',
    homeAddress: '  12 Sample Road\\nLondon  '.replace('\\n', '\n'),
    officeAddress: '',
  });
  assert.equal(parsed.senderName, 'Taylor Employee');
  assert.equal(parsed.homeAddress, '12 Sample Road\nLondon');
  assert.equal(parsed.officeAddress, null);
});

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
    STRIPE_LIVE_WEBHOOK_SECRET: 'whsec_test_only',
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

test('live checkout cannot take payment until its webhook signing secret is configured', async () => {
  const app = createApp({
    env: { ...env, STRIPE_MODE: 'live', STRIPE_LIVE_WEBHOOK_SECRET: undefined },
    store: createStore({
      createPendingLetter: async () => { throw new Error('must not create a payment record'); },
    }),
    getStripeClient: async () => { throw new Error('must not call Stripe'); },
  });
  await withApp(app, async (base) => {
    const response = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'live', form: validForm }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /webhook.*no payment was taken/i);
  });
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

test('checkout cannot charge if letter generation is not configured', async () => {
  let stripeCalls = 0;
  const app = createApp({
    env: { ...env, OPENAI_API_KEY: undefined },
    store: createStore(),
    getStripeClient: async () => { stripeCalls += 1; return {}; },
  });
  await withApp(app, async (base) => {
    const response = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'test', form: validForm }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /no payment was taken/i);
    assert.equal(stripeCalls, 0);
  });
});

test('a paid checkout without AI is refunded once and never releases a letter', async () => {
  const store = createStore();
  let created = 0;
  const stripe = {
    checkout: { sessions: { retrieve: async () => ({
      id: sessionId,
      metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
      payment_status: 'paid',
      livemode: false,
      payment_intent: 'pi_test_example',
    }), listLineItems: async () => lineItems() } },
    refunds: {
      list: async () => ({ data: [] }),
      create: async (_params, options) => {
        created += 1;
        assert.equal(options.idempotencyKey, `letter-generation-${letterId}`);
        return { id: 're_test_example', status: 'succeeded' };
      },
    },
  };
  const app = createApp({ env: { ...env, OPENAI_API_KEY: undefined }, store, getStripeClient: async () => stripe });
  await withApp(app, async (base) => {
    const post = () => fetch(`${base}/api/generate-letter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ letterId, sessionId, mode: 'test' }),
    });
    const failed = await post();
    assert.equal(failed.status, 503);
    const result = await failed.json();
    assert.equal(result.refundStatus, 'refunded');
    assert.match(result.error, /refund confirmed by Stripe/i);
    assert.equal(store.record.payment_status, 'refunded');
    assert.equal(store.record.letter_text, null);
    const retry = await post();
    assert.equal((await retry.json()).refundStatus, 'refunded');
    assert.equal(created, 1);
  });
});

test('a failed letter request never claims a refund Stripe has not confirmed', async () => {
  const store = createStore();
  const stripe = {
    checkout: { sessions: { retrieve: async () => ({
      id: sessionId,
      metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
      payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
    }), listLineItems: async () => lineItems() } },
    refunds: { list: async () => ({ data: [] }), create: async () => { throw new Error('network'); } },
  };
  const app = createApp({
    env, store, getStripeClient: async () => stripe,
    fetcher: async () => ({ ok: false }),
  });
  await withApp(app, async (base) => {
    const response = await fetch(`${base}/api/generate-letter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ letterId, sessionId, mode: 'test' }),
    });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.refundStatus, 'unconfirmed');
    assert.doesNotMatch(result.error, /refund confirmed/i);
    assert.equal(store.record.payment_status, 'refund_pending');
    assert.equal(store.record.letter_text, null);
  });
});

test('a pending Stripe refund is not shown as confirmed until Stripe succeeds', async () => {
  const store = createStore();
  let refundCreated = 0;
  let refundCompleted = false;
  const stripe = {
    checkout: { sessions: { retrieve: async () => ({
      id: sessionId,
      metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
      payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
    }), listLineItems: async () => lineItems() } },
    refunds: {
      list: async () => ({ data: refundCompleted ? [{ status: 'succeeded', metadata: { letter_id: letterId } }] : [] }),
      create: async () => { refundCreated += 1; return { status: 'pending' }; },
    },
  };
  const app = createApp({ env: { ...env, OPENAI_API_KEY: undefined }, store, getStripeClient: async () => stripe });
  await withApp(app, async (base) => {
    const post = () => fetch(`${base}/api/generate-letter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ letterId, sessionId, mode: 'test' }),
    });
    assert.equal((await (await post()).json()).refundStatus, 'pending');
    assert.equal(store.record.payment_status, 'refund_pending');
    refundCompleted = true;
    assert.equal((await (await post()).json()).refundStatus, 'refunded');
    assert.equal(store.record.payment_status, 'refunded');
    assert.equal(refundCreated, 1);
  });
});

test('a failed prior refund can be retried using the stored payment intent', async () => {
  const store = createStore();
  store.record.stripe_payment_intent_id = 'pi_test_example';
  let created = 0;
  const stripe = {
    checkout: { sessions: {
      retrieve: async () => ({
        id: sessionId,
        metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
        payment_status: 'paid', livemode: false, payment_intent: null,
      }),
      listLineItems: async () => lineItems(),
    } },
    refunds: {
      list: async () => ({ data: [{ status: 'failed', metadata: { letter_id: letterId } }] }),
      create: async (_params, options) => {
        assert.equal(options.idempotencyKey, `letter-generation-${letterId}-retry-1`);
        created += 1;
        return { status: 'succeeded' };
      },
    },
  };
  const app = createApp({ env: { ...env, OPENAI_API_KEY: undefined }, store, getStripeClient: async () => stripe });
  await withApp(app, async (base) => {
    const response = await fetch(`${base}/api/generate-letter`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ letterId, sessionId, mode: 'test' }),
    });
    assert.equal((await response.json()).refundStatus, 'refunded');
    assert.equal(created, 1);
  });
});

test('a paid letter is generated once and returns its saved date and address details', async () => {
  const store = createStore();
  let aiCalls = 0;
  const stripe = {
    checkout: { sessions: { retrieve: async () => ({
      id: sessionId,
      metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
      payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
    }), listLineItems: async () => lineItems() } },
  };
  const app = createApp({
    env, store, getStripeClient: async () => stripe,
    fetcher: async (_url, request) => {
      aiCalls += 1;
      assert.match(request.body, /Taylor Employee/);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ letter: 'Dear Morgan,\\n\\nI resign.\\n\\nTaylor Employee' }) } }] }) };
    },
  });
  await withApp(app, async (base) => {
    const post = () => fetch(`${base}/api/generate-letter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ letterId, sessionId, mode: 'test' }),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await post();
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.match(result.letter, /Taylor Employee/);
      assert.deepEqual(result.details, {
        senderName: 'Taylor Employee',
        homeAddress: '12 Sample Road\nLondon',
        officeAddress: 'Office House\nLondon',
        generatedAt: '2026-09-27T12:00:00Z',
      });
    }
    assert.equal(aiCalls, 1);
  });
});

test('a legacy paid letter remains retrievable without new sender and date columns populated', async () => {
  const store = createStore();
  store.record.payment_status = 'paid';
  store.record.sender_name = null;
  store.record.letter_generated_at = null;
  store.record.letter_text = 'Dear Morgan,\n\nAn earlier paid letter.';
  const stripe = {
    checkout: { sessions: { retrieve: async () => ({
      id: sessionId,
      metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
      payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
    }), listLineItems: async () => lineItems() } },
  };
  const app = createApp({ env, store, getStripeClient: async () => stripe });
  await withApp(app, async (base) => {
    const response = await fetch(`${base}/api/generate-letter`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ letterId, sessionId, mode: 'test' }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.letter, /earlier paid letter/);
    assert.equal(result.details.senderName, '');
    assert.equal(result.details.generatedAt, null);
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
        listLineItems: async () => lineItems(),
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
    assert.equal(store.record.return_seen_at, null);
    paid = true;
    const retry = await post();
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).verified, true);
    assert.equal(retrieveCount, 2);
    assert.equal(store.record.payment_status, 'paid');
    assert.ok(store.record.return_seen_at);
  });
});

test('a price rotation does not strand an earlier paid checkout, but a mismatched purchased item is rejected', async () => {
  const store = createStore();
  let purchasedPrice = env.STRIPE_TEST_PRICE_ID;
  const stripe = {
    checkout: { sessions: {
      retrieve: async () => ({
        id: sessionId,
        metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
        payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
      }),
      listLineItems: async () => lineItems(purchasedPrice),
    } },
  };
  const app = createApp({
    env: { ...env, STRIPE_TEST_PRICE_ID: 'price_rotated_config' },
    store, getStripeClient: async () => stripe,
  });
  await withApp(app, async (base) => {
    const post = () => fetch(`${base}/api/verify-payment`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ letterId, sessionId, mode: 'test' }),
    });
    assert.equal((await post()).status, 200);
    purchasedPrice = 'price_unrelated';
    assert.equal((await post()).status, 402);
    store.record.stripe_price_id = null; // Legacy records use the session's original Stripe metadata.
    purchasedPrice = env.STRIPE_TEST_PRICE_ID;
    assert.equal((await post()).status, 200);
  });
});

test('the server can fulfill a completed checkout when the customer returned but closed during generation', async () => {
  const store = createStore({
    claimOutstanding: async () => [{
      id: letterId, stripe_session_id: sessionId, payment_mode: 'test',
      created_at: '2026-09-27T11:00:00Z', return_seen_at: '2026-09-27T12:00:00Z',
    }],
  });
  const stripe = {
    checkout: { sessions: {
      retrieve: async () => ({
        id: sessionId,
        metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
        payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
      }),
      listLineItems: async () => lineItems(),
    } },
  };
  const app = createApp({
    env, store, getStripeClient: async () => stripe,
    fetcher: async () => ({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ letter: 'Dear Manager,\n\nI resign.\n\nTaylor Employee' }) } }],
    }) }),
  });
  await app.locals.reconcileOutstanding();
  assert.equal(store.record.payment_status, 'paid');
  assert.match(store.record.letter_text, /I resign/);
});

test('the background reconciliation refunds a failed letter after the customer returned', async () => {
  const store = createStore({
    claimOutstanding: async () => [{
      id: letterId, stripe_session_id: sessionId, payment_mode: 'test',
      created_at: '2026-09-27T11:00:00Z', return_seen_at: '2026-09-27T12:00:00Z',
    }],
  });
  const stripe = {
    checkout: { sessions: {
      retrieve: async () => ({
        id: sessionId,
        metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
        payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
      }),
      listLineItems: async () => lineItems(),
    } },
    refunds: {
      list: async () => ({ data: [] }),
      create: async () => ({ status: 'succeeded' }),
    },
  };
  const app = createApp({
    env, store, getStripeClient: async () => stripe,
    fetcher: async () => ({ ok: false }),
  });
  await app.locals.reconcileOutstanding();
  assert.equal(store.record.payment_status, 'refunded');
  assert.equal(store.record.letter_text, null);
});

test('an unreturned paid checkout is refunded after a grace period instead of creating an inaccessible letter', async () => {
  const store = createStore({
    claimOutstanding: async () => [{
      id: letterId, stripe_session_id: sessionId, payment_mode: 'test',
      created_at: new Date(Date.now() - 11 * 60_000).toISOString(), return_seen_at: null,
    }],
  });
  let refunds = 0;
  const stripe = {
    checkout: { sessions: {
      retrieve: async () => ({
        id: sessionId,
        metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
        payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
      }),
      listLineItems: async () => lineItems(),
    } },
    refunds: {
      list: async () => ({ data: [] }),
      create: async () => { refunds += 1; return { status: 'succeeded' }; },
    },
  };
  const app = createApp({
    env, store, getStripeClient: async () => stripe,
    fetcher: async () => { throw new Error('AI must not generate an inaccessible letter'); },
  });
  await app.locals.reconcileOutstanding();
  assert.equal(refunds, 1);
  assert.equal(store.record.payment_status, 'refunded');
  assert.equal(store.record.letter_text, null);
});

test('a recent paid checkout is allowed time to return before background refund', async () => {
  const store = createStore({
    claimOutstanding: async () => [{
      id: letterId, stripe_session_id: sessionId, payment_mode: 'test',
      created_at: new Date().toISOString(), return_seen_at: null,
    }],
  });
  const stripe = {
    checkout: { sessions: {
      retrieve: async () => ({
        id: sessionId,
        metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
        payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
      }),
      listLineItems: async () => lineItems(),
    } },
  };
  const app = createApp({ env, store, getStripeClient: async () => stripe });
  await app.locals.reconcileOutstanding();
  assert.equal(store.record.payment_status, 'paid');
  assert.equal(store.record.letter_text, null);
});

test('a customer returning during the unreturned-refund check keeps the letter instead of being refunded', async () => {
  let store;
  store = createStore({
    claimOutstanding: async () => [{
      id: letterId, stripe_session_id: sessionId, payment_mode: 'test',
      created_at: new Date(Date.now() - 11 * 60_000).toISOString(), return_seen_at: null,
    }],
    claimRefund: async () => {
      store.record.return_seen_at = new Date().toISOString();
      return false;
    },
  });
  let refunds = 0;
  const stripe = {
    checkout: { sessions: {
      retrieve: async () => ({
        id: sessionId,
        metadata: { letter_id: letterId, stripe_mode: 'test', stripe_price_id: env.STRIPE_TEST_PRICE_ID },
        payment_status: 'paid', livemode: false, payment_intent: 'pi_test_example',
      }),
      listLineItems: async () => lineItems(),
    } },
    refunds: {
      list: async () => ({ data: [] }),
      create: async () => { refunds += 1; return { status: 'succeeded' }; },
    },
  };
  const app = createApp({
    env, store, getStripeClient: async () => stripe,
    fetcher: async () => ({ ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ letter: 'Dear Manager,\n\nI resign.' }) } }],
    }) }),
  });
  await app.locals.reconcileOutstanding();
  assert.equal(refunds, 0);
  assert.match(store.record.letter_text, /I resign/);
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