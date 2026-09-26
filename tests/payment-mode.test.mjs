import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStripeMode } from '../src/lib/paymentMode.ts';
import {
  isStripeMode,
  isVerifiedCheckoutSession,
  paymentStatusForStripeEvent,
  stripePriceIds,
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