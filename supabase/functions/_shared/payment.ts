/**
 * Historical payment helpers shared by the Supabase/Deno Edge Functions.
 * The active app uses its Express server instead; these helpers are not part
 * of that request path, and their presence does not imply Supabase deployment.
 *
 * They centralize the old Stripe-mode checks, checkout metadata, event mapping,
 * and webhook HMAC verification so the functions apply the same rules.
 */

/** Stripe account environment selected for one checkout or event. */
export type StripeMode = 'test' | 'live';

// Historic Stripe catalog IDs: the price varies by environment, while the
// product identifier is currently shared between test and live mode.
export const stripeProductIds: Record<StripeMode, string> = {
  test: 'prod_VKfpjG7mnoKNGn',
  live: 'prod_VKfpjG7mnoKNGn',
};

export const stripePriceIds: Record<StripeMode, string> = {
  test: 'price_1UK0TaDzN5HHmyCzvFmo6OnO',
  live: 'price_1UK0rsDxbiVZ2Mt3tD1cqfbe',
};

/** Narrow an untrusted value to one of the supported Stripe environments. */
export function isStripeMode(value: unknown): value is StripeMode {
  return value === 'test' || value === 'live';
}

/**
 * Resolve the server's checkout mode. An unset value deliberately defaults to
 * test mode; an invalid configured value fails closed rather than guessing.
 */
export function configuredCheckoutMode(value: string | undefined): StripeMode | null {
  if (value === undefined) return 'test';
  return isStripeMode(value) ? value : null;
}

/**
 * Select the secret for the requested mode and check its key prefix before use.
 * Injecting the environment reader keeps configuration access at the endpoint
 * boundary and makes the selection rule independently testable.
 */
export function stripeKeyForMode(
  mode: StripeMode,
  readEnvironment: (name: string) => string | undefined,
): { ok: true; key: string } | { ok: false; error: string } {
  // Separate key names and prefixes prevent a test/live mode mismatch.
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

/**
 * Validate the configured return origin before using it in Stripe redirects.
 * HTTPS and the absence of embedded credentials avoid insecure or deceptive URLs.
 */
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

/**
 * Build Stripe's hosted one-time checkout request. Metadata goes on both the
 * Checkout Session and PaymentIntent so later events can correlate either one.
 */
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

/**
 * Require Stripe's retrieved session to match the requested letter and mode,
 * and to be paid in the corresponding test/live environment. A browser return
 * URL or caller-supplied `paid` flag is not evidence of successful payment.
 */
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

/** Payment outcomes stored by the historical webhook and accepted by the schema. */
export type PaymentStatus = 'paid' | 'failed' | 'cancelled' | 'expired';

/**
 * Shape Google Analytics Measurement Protocol fields from a verified outcome.
 * Monetary and product details are emitted only for purchases, not failures.
 */
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

/**
 * Translate only the Stripe events handled by the historic webhook; null means
 * the event is valid but irrelevant to letter payment state.
 */
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

/**
 * Compare equal-length signature strings without stopping at the first differing
 * character, reducing timing clues when validating an HMAC.
 */
function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Validate Stripe's timestamped HMAC header against the exact raw request body.
 * The five-minute timestamp window limits replay opportunities; Web Crypto keeps
 * the signing operation available in the Deno runtime without extra libraries.
 */
export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  // Stripe headers can carry multiple v1 values (for example during secret
  // rotation), so accept any matching v1 signature after validating the timestamp.
  const parts = signatureHeader.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;

  // Reject stale or future-dated deliveries before spending work on HMAC checks.
  const timestampSeconds = Number(timestamp);
  if (Math.abs(nowSeconds - timestampSeconds) > 300) return false;

  // Stripe signs `timestamp.rawBody`; hashing parsed/re-serialized JSON would
  // change the bytes and make the authentic signature impossible to verify.
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