export type StripeMode = 'test' | 'live';
export type LetterInput = {
  managerName: string;
  company: string;
  lastDay: string;
  reason: string | null;
  tone: 'grateful' | 'professional' | 'direct';
};

export const stripeProductIds: Record<StripeMode, string> = {
  test: 'prod_VKfpjG7mnoKNGn',
  live: 'prod_VKfpjG7mnoKNGn',
};

export function isStripeMode(value: unknown): value is StripeMode {
  return value === 'test' || value === 'live';
}

export function configuredCheckoutMode(value: string | undefined): StripeMode | null {
  if (value === undefined) return 'test';
  return isStripeMode(value) ? value : null;
}

export function stripeModeFromEnvironment(env: NodeJS.ProcessEnv): StripeMode | null {
  return configuredCheckoutMode(env.STRIPE_MODE);
}

export function stripePriceId(mode: StripeMode, env: NodeJS.ProcessEnv = process.env): string {
  const name = mode === 'test' ? 'STRIPE_TEST_PRICE_ID' : 'STRIPE_LIVE_PRICE_ID';
  const price = env[name];
  if (!price || !/^price_[A-Za-z0-9_]+$/.test(price)) {
    throw new Error(`${name} is missing or invalid.`);
  }
  return price;
}

export function parseLetterInput(value: unknown): LetterInput | null {
  if (!value || typeof value !== 'object') return null;
  const form = value as Record<string, unknown>;
  const managerName = typeof form.managerName === 'string' ? form.managerName.trim() : '';
  const company = typeof form.company === 'string' ? form.company.trim() : '';
  const lastDay = typeof form.lastDay === 'string' ? form.lastDay : '';
  const reason = typeof form.reason === 'string' ? form.reason.trim() : '';
  const tone = form.tone;

  if (!managerName || managerName.length > 120 || !company || company.length > 160) return null;
  if (reason.length > 1000) return null;
  if (tone !== 'grateful' && tone !== 'professional' && tone !== 'direct') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return null;
  const date = new Date(`${lastDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== lastDay) return null;

  return { managerName, company, lastDay, reason: reason || null, tone };
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

export function appOrigin(env: NodeJS.ProcessEnv): string | null {
  const explicit = configuredAppOrigin(env.APP_BASE_URL);
  if (explicit) return explicit;
  const domain = env.REPLIT_DOMAINS?.split(',')[0]?.trim();
  return domain ? configuredAppOrigin(`https://${domain}`) : null;
}

export function checkoutSessionParams(
  origin: string,
  letterId: string,
  mode: StripeMode,
  gaClientId?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const price = stripePriceId(mode, env);
  const metadata: Record<string, string> = {
    letter_id: letterId,
    stripe_mode: mode,
    stripe_product_id: stripeProductIds[mode],
    stripe_price_id: price,
  };
  if (gaClientId) metadata.ga_client_id = gaClientId;
  return {
    mode: 'payment' as const,
    line_items: [{ price, quantity: 1 }],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&letter_id=${encodeURIComponent(letterId)}&mode=${mode}`,
    cancel_url: `${origin}/?cancelled=true&mode=${mode}`,
  };
}

export function isVerifiedCheckoutSession(
  session: { id?: string; metadata?: Record<string, string | undefined> | null; payment_status?: string; livemode?: boolean },
  letterId: string,
  sessionId: string,
  mode: StripeMode,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return session.id === sessionId &&
    session.metadata?.letter_id === letterId &&
    session.metadata?.stripe_mode === mode &&
    session.metadata?.stripe_price_id === stripePriceId(mode, env) &&
    session.payment_status === 'paid' &&
    session.livemode === (mode === 'live');
}

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