import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMigrations } from 'stripe-replit-sync';
import { createApp } from './app';
import { appOrigin, stripeModeFromEnvironment } from './payment';
import { getStripeCredentials, getStripeSync, stripeKeyMatchesMode } from './stripeClient';

async function initializeStripeWhenAvailable(): Promise<void> {
  const mode = stripeModeFromEnvironment(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  const origin = appOrigin(process.env);
  if (!mode || !databaseUrl || !origin) return;

  try {
    const credentials = await getStripeCredentials(mode);
    if (!stripeKeyMatchesMode(credentials.secretKey, mode) || !credentials.webhookSecret) return;

    await runMigrations({ databaseUrl });
    const sync = await getStripeSync();
    // The signing secret belongs to the manually configured Stripe endpoint.
    // Do not create another endpoint with a different signing secret.
    await sync.syncBackfill({ object: 'all' });
  } catch {
    console.warn('Stripe synchronization is not ready. Check the selected Stripe key and webhook settings.');
  }
}

const port = Number(process.env.PORT || 5000);
const app = createApp();
const projectRoot = resolve(import.meta.dirname, '..');

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

if (process.env.NODE_ENV === 'production') {
  const dist = resolve(projectRoot, 'dist');
  app.use(express.static(dist, { index: false }));
  app.get(/.*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get(/.*/, async (req, res, next) => {
    try {
      const template = await readFile(resolve(projectRoot, 'index.html'), 'utf8');
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).type('html').send(html);
    } catch (error) {
      next(error);
    }
  });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`ResignLetter server listening on port ${port}`);
});
void initializeStripeWhenAvailable();

const reconcile = app.locals.reconcileOutstanding as () => Promise<void>;
function runReconciliation() {
  void reconcile().catch(() => console.warn('Payment fulfillment reconciliation failed; it will retry.'));
}
setTimeout(runReconciliation, 5_000).unref();
setInterval(runReconciliation, 60_000).unref();