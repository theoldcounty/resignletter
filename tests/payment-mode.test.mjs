// Payment-mode regression tests cover browser, Node, and Supabase Edge helpers together.
// This catches contract drift across runtimes without making a real Stripe API call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStripeMode } from '../src/lib/paymentMode.ts';
import {
  checkoutSessionParams as serverCheckoutSessionParams,
  isVerifiedCheckoutSession as isServerVerifiedCheckoutSession,
  stripeModeFromEnvironment,
  stripePriceId,
} from '../server/payment.ts';
import {
  checkoutSessionParams,
  configuredCheckoutMode,
  isStripeMode,
  isVerifiedCheckoutSession,
  paymentAnalyticsParams,
  paymentStatusForStripeEvent,
  stripePriceIds,
  stripeKeyForMode,
  verifyStripeSignature,
} from '../supabase/functions/_shared/payment.ts';

test('defaults unknown or missing browser mode values to test mode', () => {
  // A return URL or browser value must never promote itself into live mode.
  assert.equal(normalizeStripeMode(null), 'test');
  assert.equal(normalizeStripeMode('unexpected'), 'test');
  assert.equal(normalizeStripeMode('live'), 'live');
});

test('accepts only explicit test and live modes on the payment backend', () => {
  // Restrict server mode values to the two Stripe environments the app deliberately supports.
  assert.equal(isStripeMode('test'), true);
  assert.equal(isStripeMode('live'), true);
  assert.equal(isStripeMode('production'), false);
});

test('only the configured server payment mode can start checkout', () => {
  // Invalid deployment configuration fails closed instead of silently selecting a different environment.
  assert.equal(configuredCheckoutMode(undefined), 'test');
  assert.equal(configuredCheckoutMode('test'), 'test');
  assert.equal(configuredCheckoutMode('live'), 'live');
  assert.equal(configuredCheckoutMode('sandbox'), null);
  assert.equal(configuredCheckoutMode(''), null);
  assert.notEqual(configuredCheckoutMode('test'), 'live');
  assert.notEqual(configuredCheckoutMode('live'), 'test');
});

test('STRIPE_MODE is the canonical server mode configuration', () => {
  // The Node backend reads the same explicit mode contract as the Edge functions.
  assert.equal(stripeModeFromEnvironment({ STRIPE_MODE: 'test' }), 'test');
  assert.equal(stripeModeFromEnvironment({ STRIPE_MODE: 'live' }), 'live');
  assert.equal(stripeModeFromEnvironment({ STRIPE_MODE: 'invalid' }), null);
  assert.equal(stripeModeFromEnvironment({}), 'test');
});

test('server checkout reads the mode-specific configured price ID', () => {
  // Distinct configured prices and mode metadata let later verification bind a checkout to its product.
  const env = {
    STRIPE_TEST_PRICE_ID: 'price_test_configured',
    STRIPE_LIVE_PRICE_ID: 'price_live_configured',
  };

  assert.equal(stripePriceId('test', env), 'price_test_configured');
  assert.equal(stripePriceId('live', env), 'price_live_configured');
  assert.throws(() => stripePriceId('test', {}), /STRIPE_TEST_PRICE_ID/);

  const liveParams = serverCheckoutSessionParams('https://app.example', 'letter-live', 'live', undefined, env);
  assert.equal(liveParams.line_items[0].price, 'price_live_configured');
  assert.equal(liveParams.metadata.stripe_mode, 'live');
  assert.equal(liveParams.metadata.stripe_price_id, 'price_live_configured');
  assert.match(liveParams.success_url, /mode=live/);
});

test('server return verification uses the configured price for the selected mode', () => {
  // A rotated price may not be substituted during return verification: the configured purchase must match.
  const env = {
    STRIPE_TEST_PRICE_ID: 'price_test_configured',
    STRIPE_LIVE_PRICE_ID: 'price_live_configured',
  };
  const liveSession = {
    id: 'cs_live_example',
    metadata: {
      letter_id: 'letter-live',
      stripe_mode: 'live',
      stripe_price_id: 'price_live_configured',
    },
    payment_status: 'paid',
    livemode: true,
  };

  assert.equal(isServerVerifiedCheckoutSession(liveSession, 'letter-live', 'cs_live_example', 'live', env), true);
  assert.equal(isServerVerifiedCheckoutSession(liveSession, 'letter-live', 'cs_live_example', 'live', {
    ...env,
    STRIPE_LIVE_PRICE_ID: 'price_another_live',
  }), false);
});

test('uses a separate public price ID for each Stripe mode', () => {
  // Even publishable price identifiers stay separate so test and live products cannot be confused.
  assert.notEqual(stripePriceIds.test, stripePriceIds.live);
});

test('test payments select only a test key, never a live key', () => {
  // Recording environment lookups proves a test request never even reads the live secret.
  const requests = [];
  // Deliberately return a live-looking value for other names to expose an accidental fallback.
  const readEnvironment = (name) => {
    requests.push(name);
    return name === 'STRIPE_TEST_SECRET_KEY' ? 'sk_test_mock' : 'sk_live_mock';
  };

  assert.deepEqual(stripeKeyForMode('test', readEnvironment), { ok: true, key: 'sk_test_mock' });
  assert.deepEqual(requests, ['STRIPE_TEST_SECRET_KEY']);
  assert.deepEqual(stripeKeyForMode('test', () => 'sk_live_mock'), {
    ok: false,
    error: 'The test Stripe key does not match its selected mode.',
  });
  assert.deepEqual(stripeKeyForMode('live', () => undefined), {
    ok: false,
    error: 'Live Stripe mode is not configured.',
  });
});

test('a mocked test checkout uses the test price and releases only a verified paid letter', async () => {
  // This small Stripe-shaped fake validates the SDK call contract without network or credentials.
  const letterId = 'letter mock/123';
  const params = checkoutSessionParams('https://app.example', letterId, 'test', '123.456');
  const fakeStripe = {
    checkout: {
      sessions: {
        create: async (input) => {
          assert.deepEqual(input, params);
          assert.equal(input.line_items[0].price, stripePriceIds.test);
          assert.equal(input.metadata.stripe_mode, 'test');
          assert.equal(input.metadata.ga_client_id, '123.456');
          assert.equal(input.success_url.includes('letter_id=letter%20mock%2F123'), true);
          return { id: 'cs_test_mock', url: 'https://checkout.stripe.test/mock' };
        },
        retrieve: async () => ({
          metadata: params.metadata,
          payment_status: 'paid',
          livemode: false,
        }),
      },
    },
  };

  const checkout = await fakeStripe.checkout.sessions.create(params);
  assert.equal(checkout.url, 'https://checkout.stripe.test/mock');
  const paidSession = await fakeStripe.checkout.sessions.retrieve(checkout.id);
  assert.equal(isVerifiedCheckoutSession(paidSession, letterId, 'test'), true);
  assert.equal(isVerifiedCheckoutSession({ ...paidSession, livemode: true }, letterId, 'test'), false);
  assert.equal(paymentStatusForStripeEvent('checkout.session.completed', paidSession.payment_status), 'paid');
});

test('verifies paid sessions against the expected letter and mode', () => {
  // Treat session payment state, letter ownership, and Stripe live/test state as independent checks.
  const paidTestSession = {
    metadata: { letter_id: 'letter-123', stripe_mode: 'test' },
    payment_status: 'paid',
    livemode: false,
  };

  assert.equal(isVerifiedCheckoutSession(paidTestSession, 'letter-123', 'test'), true);
  assert.equal(isVerifiedCheckoutSession(paidTestSession, 'letter-456', 'test'), false);
  assert.equal(isVerifiedCheckoutSession(paidTestSession, 'letter-123', 'live'), false);
  assert.equal(
    isVerifiedCheckoutSession({ ...paidTestSession, payment_status: 'unpaid' }, 'letter-123', 'test'),
    false,
  );
});

test('maps Stripe payment events to persisted states', () => {
  // Ignore unrelated Stripe events so only recognized payment lifecycle signals mutate stored status.
  assert.equal(paymentStatusForStripeEvent('checkout.session.completed', 'paid'), 'paid');
  assert.equal(paymentStatusForStripeEvent('checkout.session.completed', 'unpaid'), null);
  assert.equal(paymentStatusForStripeEvent('payment_intent.payment_failed'), 'failed');
  assert.equal(paymentStatusForStripeEvent('checkout.session.expired'), 'expired');
  assert.equal(paymentStatusForStripeEvent('customer.created'), null);
});

test('tracks payment value without sending Stripe session or payment identifiers to analytics', () => {
  // Analytics needs an aggregate amount, not checkout IDs that could correlate visitors to transactions.
  const params = paymentAnalyticsParams('paid', 'test', 'prod_public', 100, 'gbp');

  assert.deepEqual(params, {
    payment_mode: 'test',
    payment_status: 'paid',
    value: 1,
    currency: 'GBP',
    items: [{ item_id: 'prod_public', quantity: 1 }],
  });
  assert.equal('transaction_id' in params, false);
  assert.equal('session_id' in params, false);
  assert.equal('payment_intent_id' in params, false);

  assert.deepEqual(paymentAnalyticsParams('failed', 'test'), {
    payment_mode: 'test',
    payment_status: 'failed',
  });
});

test('verifies Stripe webhook signatures and rejects tampered or stale requests', async () => {
  // Use Web Crypto to construct the same timestamped HMAC shape Stripe signs; then mutate one trust input at a time.
  const payload = JSON.stringify({ id: 'evt_test', livemode: false });
  const secret = 'unit-test-key';
  const timestamp = 1_800_000_000;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const header = `t=${timestamp},v1=${signature}`;

  assert.equal(await verifyStripeSignature(payload, header, secret, timestamp), true);
  assert.equal(await verifyStripeSignature(`${payload} `, header, secret, timestamp), false);
  assert.equal(await verifyStripeSignature(payload, header, secret, timestamp + 301), false);
});