import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStripeMode } from '../src/lib/paymentMode.ts';
import {
  checkoutSessionParams,
  isStripeMode,
  isVerifiedCheckoutSession,
  paymentAnalyticsParams,
  paymentStatusForStripeEvent,
  stripePriceIds,
  stripeKeyForMode,
  verifyStripeSignature,
} from '../supabase/functions/_shared/payment.ts';

test('defaults unknown or missing browser mode values to test mode', () => {
  assert.equal(normalizeStripeMode(null), 'test');
  assert.equal(normalizeStripeMode('unexpected'), 'test');
  assert.equal(normalizeStripeMode('live'), 'live');
});

test('accepts only explicit test and live modes on the payment backend', () => {
  assert.equal(isStripeMode('test'), true);
  assert.equal(isStripeMode('live'), true);
  assert.equal(isStripeMode('production'), false);
});

test('uses a separate public price ID for each Stripe mode', () => {
  assert.notEqual(stripePriceIds.test, stripePriceIds.live);
});

test('test payments select only a test key, never a live key', () => {
  const requests = [];
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
  assert.equal(paymentStatusForStripeEvent('checkout.session.completed', 'paid'), 'paid');
  assert.equal(paymentStatusForStripeEvent('checkout.session.completed', 'unpaid'), null);
  assert.equal(paymentStatusForStripeEvent('payment_intent.payment_failed'), 'failed');
  assert.equal(paymentStatusForStripeEvent('checkout.session.expired'), 'expired');
  assert.equal(paymentStatusForStripeEvent('customer.created'), null);
});

test('tracks payment value without sending Stripe session or payment identifiers to analytics', () => {
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