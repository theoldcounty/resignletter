export type StripeMode = 'test' | 'live';

export const stripeProductIds: Record<StripeMode, string> = {
  test: 'prod_VKfpjG7mnoKNGn',
  live: 'prod_VKfpjG7mnoKNGn',
};

export const stripePriceIds: Record<StripeMode, string> = {
  test: 'price_1UK0TaDzN5HHmyCzvFmo6OnO',
  live: 'price_1UK0rsDxbiVZ2Mt3tD1cqfbe',
};

export function isStripeMode(value: unknown): value is StripeMode {
  return value === 'test' || value === 'live';
}

export function isVerifiedCheckoutSession(
  session: {
    metadata?: Record<string, string | undefined> | null;
    payment_status?: string;
    livemode?: boolean;
  },
  letterId: string,
  mode: StripeMode,
): boolean {
  return (
    session.metadata?.letter_id === letterId &&
    session.metadata?.stripe_mode === mode &&
    session.payment_status === 'paid' &&
    session.livemode === (mode === 'live')
  );
}

export type PaymentStatus = 'paid' | 'failed' | 'cancelled' | 'expired';

export function paymentStatusForStripeEvent(
  eventType: string,
  sessionPaymentStatus?: string,
): PaymentStatus | null {
  if (
    (eventType === 'checkout.session.completed' ||
      eventType === 'checkout.session.async_payment_succeeded') &&
    sessionPaymentStatus === 'paid'
  ) {
    return 'paid';
  }
  if (
    eventType === 'payment_intent.payment_failed' ||
    eventType === 'checkout.session.async_payment_failed'
  ) {
    return 'failed';
  }
  if (eventType === 'checkout.session.expired') return 'expired';
  return null;
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = signatureHeader.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;

  const timestampSeconds = Number(timestamp);
  if (Math.abs(nowSeconds - timestampSeconds) > 300) return false;

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
  const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return signatures.some((signature) => constantTimeEquals(signature, expected));
}