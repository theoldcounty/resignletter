import Stripe from 'stripe';
import { StripeSync } from 'stripe-replit-sync';
import { stripeModeFromEnvironment, type StripeMode } from './payment';

export type StripeCredentials = { secretKey: string; webhookSecret?: string };

/**
 * Read project Secrets on every use so rotated values are picked up without caching.
 */
export async function getStripeCredentials(
  mode: StripeMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StripeCredentials> {
  const secretKey = mode === 'test' ? env.STRIPE_TEST_SECRET_KEY : env.STRIPE_LIVE_SECRET_KEY;
  const webhookSecret = mode === 'test' ? env.STRIPE_TEST_WEBHOOK_SECRET : env.STRIPE_LIVE_WEBHOOK_SECRET;
  if (!secretKey) throw new Error('Stripe is not configured.');
  if (!stripeKeyMatchesMode(secretKey, mode)) {
    throw new Error('The Stripe Secret does not match the selected payment mode.');
  }
  return { secretKey, webhookSecret };
}

export function stripeKeyMatchesMode(secretKey: string, mode: StripeMode): boolean {
  return secretKey.startsWith(mode === 'test' ? 'sk_test_' : 'sk_live_');
}

/** Returns a fresh Stripe client; secrets are never cached. */
export async function getUncachableStripeClient(mode: StripeMode): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials(mode);
  if (!stripeKeyMatchesMode(secretKey, mode)) {
    throw new Error(`The ${mode} Stripe key does not match its selected mode.`);
  }
  return new Stripe(secretKey, { timeout: 20_000 });
}

export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Database is not configured.');
  const mode = stripeModeFromEnvironment(process.env);
  if (!mode) throw new Error('STRIPE_MODE must be test or live.');
  const { secretKey, webhookSecret } = await getStripeCredentials(mode);
  if (!stripeKeyMatchesMode(secretKey, mode) || !webhookSecret) {
    throw new Error('Stripe webhook is not configured.');
  }
  return new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret,
  });
}