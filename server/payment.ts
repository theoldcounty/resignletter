/**
 * Pure payment-domain helpers shared by API routes and the Stripe adapter.
 * Centralizing validation and session construction keeps client input separate
 * from server-selected Stripe prices, modes, and return destinations.
 */
/** The selected Stripe account environment; never infer it from request data. */
export type StripeMode = 'test' | 'live';

/** Normalized, size-limited form fields persisted for later fulfillment. */
export type LetterInput = {
  senderName: string;
  managerName: string;
  company: string;
  lastDay: string;
  reason: string | null;
  homeAddress: string | null;
  officeAddress: string | null;
  tone: 'grateful' | 'professional' | 'direct';
};

// Product identity is shared across environments; the actual price remains
// mode-specific and comes from the corresponding server-side environment value.
export const stripeProductIds: Record<StripeMode, string> = {
  test: 'prod_VKfpjG7mnoKNGn',
  live: 'prod_VKfpjG7mnoKNGn',
};

/** Narrow untrusted values to the two supported Stripe environments. */
export function isStripeMode(value: unknown): value is StripeMode {
  return value === 'test' || value === 'live';
}

/**
 * Resolve the optional mode setting. A missing value intentionally defaults to
 * sandbox for safe local development; an invalid explicit value fails closed.
 */
export function configuredCheckoutMode(value: string | undefined): StripeMode | null {
  if (value === undefined) return 'test';
  return isStripeMode(value) ? value : null;
}

/** Read the process-selected payment environment without consulting the caller. */
export function stripeModeFromEnvironment(env: NodeJS.ProcessEnv): StripeMode | null {
  return configuredCheckoutMode(env.STRIPE_MODE);
}

/**
 * Choose a price from trusted environment configuration, never request input.
 * Throwing here lets route handlers return a clear configuration error before
 * creating a Checkout Session.
 */
export function stripePriceId(mode: StripeMode, env: NodeJS.ProcessEnv = process.env): string {
  const name = mode === 'test' ? 'STRIPE_TEST_PRICE_ID' : 'STRIPE_LIVE_PRICE_ID';
  const price = env[name];
  if (!price || !/^price_[A-Za-z0-9_]+$/.test(price)) {
    throw new Error(`${name} is missing or invalid.`);
  }
  return price;
}

/**
 * Validate and normalize a browser form before persistence or model use.
 * Returning null gives routes one fail-closed result for malformed types,
 * oversized fields, invalid tone values, and impossible calendar dates.
 */
export function parseLetterInput(value: unknown): LetterInput | null {
  if (!value || typeof value !== 'object') return null;
  // Request JSON has no trusted static type; inspect each field before calling
  // string methods or passing it across a storage/API boundary.
  const form = value as Record<string, unknown>;
  const senderName = typeof form.senderName === 'string' ? form.senderName.trim() : '';
  const managerName = typeof form.managerName === 'string' ? form.managerName.trim() : '';
  const company = typeof form.company === 'string' ? form.company.trim() : '';
  const lastDay = typeof form.lastDay === 'string' ? form.lastDay : '';
  const reason = typeof form.reason === 'string' ? form.reason.trim() : '';
  // Normalize Windows line endings so address blocks render consistently in
  // generated letters and documents on every platform.
  const homeAddress = typeof form.homeAddress === 'string' ? form.homeAddress.replace(/\r\n/g, '\n').trim() : '';
  const officeAddress = typeof form.officeAddress === 'string' ? form.officeAddress.replace(/\r\n/g, '\n').trim() : '';
  const tone = form.tone;

  // Enforce limits at the API boundary as well as in the database so callers
  // receive a validation response instead of a later constraint error.
  if (!senderName || senderName.length > 120) return null;
  if (!managerName || managerName.length > 120 || !company || company.length > 160) return null;
  if (reason.length > 1000 || homeAddress.length > 500 || officeAddress.length > 500) return null;
  if (tone !== 'grateful' && tone !== 'professional' && tone !== 'direct') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return null;
  // Round-trip the ISO date because Date can normalize impossible dates such
  // as February 30 into a different valid day.
  const date = new Date(`${lastDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== lastDay) return null;

  return {
    senderName, managerName, company, lastDay, reason: reason || null,
    homeAddress: homeAddress || null, officeAddress: officeAddress || null, tone,
  };
}

/**
 * Accept only bare HTTPS origins. Reject credentials and paths so Stripe's
 * success/cancel redirects cannot be redirected to an attacker-controlled URL.
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
 * Prefer an explicit deployment URL, then the first Replit domain. Both paths
 * use the same HTTPS/origin validation before a value reaches Stripe.
 */
export function appOrigin(env: NodeJS.ProcessEnv): string | null {
  const explicit = configuredAppOrigin(env.APP_BASE_URL);
  if (explicit) return explicit;
  const domain = env.REPLIT_DOMAINS?.split(',')[0]?.trim();
  return domain ? configuredAppOrigin(`https://${domain}`) : null;
}

/**
 * Build the server-owned Stripe Checkout contract for one validated order.
 * Metadata links callbacks to the letter; success/cancel URLs carry references,
 * not payment proof, and the API must verify the session before fulfillment.
 */
export function checkoutSessionParams(
  origin: string,
  letterId: string,
  mode: StripeMode,
  gaClientId?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  // Resolve the selected environment's price here so no browser-supplied amount
  // or product can change what Stripe charges.
  const price = stripePriceId(mode, env);
  // Stripe copies session metadata onto payment intents, allowing either event
  // family to be correlated with the same letter record.
  const metadata: Record<string, string> = {
    letter_id: letterId,
    stripe_mode: mode,
    stripe_product_id: stripeProductIds[mode],
    stripe_price_id: price,
  };
  if (gaClientId) metadata.ga_client_id = gaClientId;
  return {
    mode: 'payment' as const,
    // Only synchronous card payments: without webhooks, delayed payment methods
    // cannot reliably trigger fulfillment when the buyer leaves Checkout.
    payment_method_types: ['card' as const],
    line_items: [{ price, quantity: 1 }],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&letter_id=${encodeURIComponent(letterId)}&mode=${mode}`,
    cancel_url: `${origin}/?cancelled=true&mode=${mode}`,
  };
}

/**
 * Compare a Stripe-retrieved session with the expected letter, session, mode,
 * and price. This is a consistency check on provider data, not a check of
 * client-provided query parameters.
 */
export function isVerifiedCheckoutSession(
  session: { id?: string; metadata?: Record<string, string | undefined> | null; payment_status?: string; livemode?: boolean },
  letterId: string,
  sessionId: string,
  mode: StripeMode,
  env: NodeJS.ProcessEnv = process.env,
  expectedPriceId: string = stripePriceId(mode, env),
): boolean {
  return session.id === sessionId &&
    session.metadata?.letter_id === letterId &&
    session.metadata?.stripe_mode === mode &&
    session.metadata?.stripe_price_id === expectedPriceId &&
    session.payment_status === 'paid' &&
    session.livemode === (mode === 'live');
}

/**
 * Translate only fulfillment-relevant Stripe events into application states.
 * Unrelated events return null so they cannot accidentally change an order.
 */
export function paymentStatusForStripeEvent(eventType: string, sessionPaymentStatus?: string) {
  if (
    (eventType === 'checkout.session.completed' || eventType === 'checkout.session.async_payment_succeeded') &&
    sessionPaymentStatus === 'paid'
  ) return 'paid' as const;
  if (eventType === 'payment_intent.payment_failed' || eventType === 'checkout.session.async_payment_failed') {
    return 'failed' as const;
  }
  if (eventType === 'checkout.session.expired') return 'expired' as const;
  return null;
}