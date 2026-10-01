/**
 * Node server entry point: prepare Stripe's local sync when credentials and
 * database configuration are ready, mount the API, serve the UI, and start
 * periodic recovery for orders whose customer returned after paying.
 */
import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMigrations } from 'stripe-replit-sync';
import { createApp } from './app';
import { appOrigin, stripeModeFromEnvironment } from './payment';
import { getStripeCredentials, getStripeSync, stripeKeyMatchesMode } from './stripeClient';

/**
 * Initialize the Stripe Sync integration only when the selected mode, database,
 * public origin, API key, and webhook secret are all configured. Startup remains
 * available if Stripe is temporarily unconfigured; payment routes fail closed.
 */
async function initializeStripeWhenAvailable(): Promise<void> {
  // Stripe Sync needs the same database as the API and an externally reachable
  // origin for setup; skip the integration until all prerequisites are present.
  const mode = stripeModeFromEnvironment(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  const origin = appOrigin(process.env);
  if (!mode || !databaseUrl || !origin) return;

  try {
    // Check key prefix and endpoint signing secret before database migrations
    // or any Stripe synchronization work.
    const credentials = await getStripeCredentials(mode);
    if (!stripeKeyMatchesMode(credentials.secretKey, mode) || !credentials.webhookSecret) return;

    // The sync library owns Stripe's supporting tables. Apply its migrations
    // before asking it to retrieve historical objects.
    await runMigrations({ databaseUrl });
    const sync = await getStripeSync();
    // Reuse the manually configured endpoint's signing secret. Backfill
    // retrieves prior Stripe objects for recovery; it does not create a second
    // endpoint with a different signing secret.
    await sync.syncBackfill({ object: 'all' });
  } catch {
    console.warn('Stripe synchronization is not ready. Check the selected Stripe key and webhook settings.');
  }
}

// Keep the listening port and project root in one place for both production
// static serving and Vite's development middleware.
const port = Number(process.env.PORT || 5000);
const app = createApp();
const projectRoot = resolve(import.meta.dirname, '..');

// Return JSON for unknown API paths before the page fallback can serve index.html.
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

if (process.env.NODE_ENV === 'production') {
  // In production, serve the prebuilt client bundle from dist. Do not let
  // Express implicitly choose an index file; the explicit fallback owns routing.
  const dist = resolve(projectRoot, 'dist');
  app.use(express.static(dist, { index: false }));
  app.get(/.*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
} else {
  // Load Vite only in development and use middleware mode so API and browser
  // requests share one HTTP server without starting Vite's separate listener.
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get(/.*/, async (req, res, next) => {
    try {
      // Transform the HTML entry for the current URL so Vite can inject its
      // development client and resolve frontend modules.
      const template = await readFile(resolve(projectRoot, 'index.html'), 'utf8');
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).type('html').send(html);
    } catch (error) {
      // Hand rendering failures to Express' error pipeline instead of hiding
      // them behind a successful HTML response.
      next(error);
    }
  });
}

// Bind all interfaces so the Replit proxy/container can reach the process.
app.listen(port, '0.0.0.0', () => {
  console.log(`ResignLetter server listening on port ${port}`);
});
// Stripe setup is intentionally non-blocking: serving the app does not require
// the optional sync/backfill to complete first.
void initializeStripeWhenAvailable();

// The app factory exposes a recovery callback used by the webhook and by these
// timers; scheduling remains here so route construction itself has no timer side
// effects in tests.
const reconcile = app.locals.reconcileOutstanding as () => Promise<void>;
function runReconciliation() {
  // Background failures are logged and retried on the next scheduled pass.
  void reconcile().catch(() => console.warn('Payment fulfillment reconciliation failed; it will retry.'));
}
// Check soon after startup, then periodically. unref() lets process shutdown
// proceed naturally when these timers are the only remaining handles.
setTimeout(runReconciliation, 5_000).unref();
setInterval(runReconciliation, 60_000).unref();