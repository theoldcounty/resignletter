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

export function stripeKeyForMode(
  mode: StripeMode,
  readEnvironment: (name: string) => string | undefined,
): { ok: true; key: string } | { ok: false; error: string } {
  const name = mode === 'test' ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY';
  const key = readEnvironment(name);
  if (!key) {
    return { ok: false, error: `${mode === 'test' ? 'Test' : 'Live'} Stripe mode is not configured.` };
  }
  if (!key.startsWith(mode === 'test' ? 'sk_test_' : 'sk_live_')) {
    return { ok: false, error: `The ${mode} Stripe key does not match its selected mode.` };
  }
  return { ok: true, key };
}

export function configuredAppOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function checkoutSessionParams(
  origin: string,
  letterId: string,
  mode: StripeMode,
  gaClientId?: string,
) {
  const metadata: Record<string, string> = {
    letter_id: letterId,
    stripe_mode: mode,
    stripe_product_id: stripeProductIds[mode],
    stripe_price_id: stripePriceIds[mode],
  };
  if (gaClientId) metadata.ga_client_id = gaClientId;

  return {
    mode: 'payment' as const,
    line_items: [{ price: stripePriceIds[mode], quantity: 1 }],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&letter_id=${encodeURIComponent(letterId)}&mode=${mode}`,
    cancel_url: `${origin}/?cancelled=true&mode=${mode}`,
  };
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

export function paymentAnalyticsParams(
  paymentStatus: PaymentStatus,
  mode: StripeMode,
  productId?: string,
  amountMinorUnits?: number,
  currency?: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    payment_mode: mode,
    payment_status: paymentStatus,
  };

  if (paymentStatus === 'paid') {
    if (
      typeof amountMinorUnits === 'number' &&
      Number.isFinite(amountMinorUnits) &&
      amountMinorUnits >= 0
    ) {
      params.value = amountMinorUnits / 100;
    }
    if (currency && /^[a-z]{3}$/i.test(currency)) params.currency = currency.toUpperCase();
    if (productId) params.items = [{ item_id: productId, quantity: 1 }];
  }

  return params;
}

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