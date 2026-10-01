/**
 * Server-only Stripe connection boundary.
 * Stripe's official SDK owns authenticated API calls, while stripe-replit-sync
 * shares those credentials and PostgreSQL storage for webhook/backfill support.
 * Secrets are read at call time so Replit Secret rotation does not require a
 * process restart or leave old credentials cached.
 */
import Stripe from 'stripe';
import { StripeSync } from 'stripe-replit-sync';
import { stripeModeFromEnvironment, type StripeMode } from './payment';

export type StripeCredentials = { secretKey: string; webhookSecret?: string };

/**
 * Read project Secrets on every use so rotated values are picked up without caching.
 * Select keys solely from the server's configured mode, then reject a key whose
 * prefix indicates it belongs to the other Stripe environment.
 */
export async function getStripeCredentials(
  mode: StripeMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StripeCredentials> {
  // Separate test and live credentials so a mode mix-up cannot silently charge
  // through the wrong Stripe account.
  const secretKey = mode === 'test' ? env.STRIPE_TEST_SECRET_KEY : env.STRIPE_LIVE_SECRET_KEY;
  const webhookSecret = mode === 'test' ? env.STRIPE_TEST_WEBHOOK_SECRET : env.STRIPE_LIVE_WEBHOOK_SECRET;
  if (!secretKey) throw new Error('Stripe is not configured.');
  if (!stripeKeyMatchesMode(secretKey, mode)) {
    throw new Error('The Stripe Secret does not match the selected payment mode.');
  }
  return { secretKey, webhookSecret };
}

/**
 * Fast configuration sanity check for Stripe's documented key prefixes.
 * Stripe remains authoritative for key validity when the SDK makes an API call.
 */
export function stripeKeyMatchesMode(secretKey: string, mode: StripeMode): boolean {
  return secretKey.startsWith(mode === 'test' ? 'sk_test_' : 'sk_live_');
}

/**
 * Return a fresh official Stripe SDK client for the selected account.
 * Avoid caching the client so rotated Replit Secrets are observed on the next
 * request; the timeout bounds upstream calls without changing retry policy.
 */
export async function getUncachableStripeClient(mode: StripeMode): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials(mode);
  if (!stripeKeyMatchesMode(secretKey, mode)) {
    throw new Error(`The ${mode} Stripe key does not match its selected mode.`);
  }
  return new Stripe(secretKey, { timeout: 20_000 });
}

/**
 * Construct stripe-replit-sync with the same account mode and application
 * database as the API. This integration stores/backfills Stripe-side records;
 * the application still verifies paid sessions before delivering letters.
 */
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