import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const baseUrl = 'http://127.0.0.1:5199';
let server;
let browser;
let serverOutput = '';

before(async () => {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], {
    env: {
      ...process.env,
      STRIPE_MODE: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Wait for Vite to start.
    }
    await sleep(100);
  }
  if (!ready) throw new Error(`Browser test server did not start: ${serverOutput}`);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

async function fillLetterForm(page) {
  await page.getByRole('button', { name: 'Reject analytics' }).click();
  await page.locator('input[placeholder="e.g. Sarah Johnson"]').fill('Alex Manager');
  await page.locator('input[placeholder="e.g. Acme Corporation"]').fill('Example Ltd');
  await page.locator('input[type="date"]').fill('2026-10-30');
  await page.locator('input[type="checkbox"]').check();
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

test('sandbox form reaches checkout, returns a paid letter, and supports download', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const checkoutRequests = [];
  const verificationRequests = [];
  const generationRequests = [];
  try {
    await page.route('**/api/checkout', async (route) => {
      checkoutRequests.push(route.request().postDataJSON());
      await route.fulfill(json({ url: 'https://checkout.stripe.test/mock' }));
    });
    await page.route('**/api/verify-payment', async (route) => {
      verificationRequests.push(route.request().postDataJSON());
      await route.fulfill(json({ verified: true, mode: 'test' }));
    });
    await page.route('**/api/generate-letter', async (route) => {
      generationRequests.push(route.request().postDataJSON());
      await route.fulfill(json({ letter: 'Dear Alex Manager,\n\nI am resigning from Example Ltd.\n\nSincerely' }));
    });
    await page.route('https://checkout.stripe.test/mock', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<h1>Mock Stripe Sandbox</h1><a href="${baseUrl}/?session_id=cs_test_mock&letter_id=letter-123&mode=test">Complete sandbox payment</a>`,
      });
    });

    await page.goto(baseUrl);
    assert.equal(await page.getByText('Sandbox', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Test', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Live', exact: true }).count(), 0);
    await fillLetterForm(page);
    const checkoutButton = page.getByRole('button', { name: 'Continue to Stripe Checkout' });
    assert.equal(await checkoutButton.isEnabled(), true);
    await checkoutButton.click();
    await page.waitForURL('https://checkout.stripe.test/mock');
    await page.getByRole('link', { name: 'Complete sandbox payment' }).click();
    await page.getByRole('heading', { name: 'Your Resignation Letter' }).waitFor();

    assert.match(await page.locator('pre').innerText(), /Dear Alex Manager/);
    assert.equal(new URL(page.url()).search, '');
    assert.equal(checkoutRequests.length, 1);
    assert.equal(checkoutRequests[0].mode, 'test');
    assert.equal(checkoutRequests[0].form.managerName, 'Alex Manager');
    assert.deepEqual(verificationRequests, [{
      letterId: 'letter-123',
      sessionId: 'cs_test_mock',
      mode: 'test',
    }]);
    assert.deepEqual(generationRequests, [{
      letterId: 'letter-123',
      sessionId: 'cs_test_mock',
      mode: 'test',
    }]);

    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    assert.equal((await downloaded).suggestedFilename(), 'resignation-letter.txt');
  } finally {
    await context.close();
  }
});

test('failed verification and generation retain the return link for retry without another checkout', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let verifications = 0;
  let generations = 0;
  let newCheckouts = 0;
  try {
    await page.route('**/api/checkout', async (route) => {
      newCheckouts += 1;
      await route.fulfill(json({ error: 'Unexpected checkout' }, 500));
    });
    await page.route('**/api/verify-payment', async (route) => {
      verifications += 1;
      await route.fulfill(
        verifications === 1
          ? json({ error: 'Payment could not be verified.' }, 402)
          : json({ verified: true, mode: 'test' }),
      );
    });
    await page.route('**/api/generate-letter', async (route) => {
      generations += 1;
      await route.fulfill(
        generations === 1
          ? json({ error: 'Letter generation temporarily unavailable.' }, 502)
          : json({ letter: 'Dear Alex Manager,\n\nPlease accept my resignation.' }),
      );
    });

    await page.goto(`${baseUrl}/?session_id=cs_test_retry&letter_id=letter-456&mode=test`);
    await page.getByText('Payment could not be verified.', { exact: true }).waitFor();
    assert.match(page.url(), /session_id=cs_test_retry/);
    await page.getByRole('button', { name: 'Retry getting my letter' }).click();
    await page.getByText('Letter generation temporarily unavailable.', { exact: true }).waitFor();
    assert.match(page.url(), /session_id=cs_test_retry/);
    await page.getByRole('button', { name: 'Retry getting my letter' }).click();
    await page.getByRole('heading', { name: 'Your Resignation Letter' }).waitFor();
    assert.equal(new URL(page.url()).search, '');
    assert.equal(verifications, 3);
    assert.equal(generations, 2);
    assert.equal(newCheckouts, 0);
  } finally {
    await context.close();
  }
});

test('checkout setup errors show a failure and allow another attempt', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route('**/api/checkout', async (route) => {
      await route.fulfill(json({ error: 'Payment setup is temporarily unavailable.' }, 503));
    });
    await page.goto(baseUrl);
    await fillLetterForm(page);
    const checkoutButton = page.getByRole('button', { name: 'Continue to Stripe Checkout' });
    await checkoutButton.click();
    await page.getByRole('alert').getByText('Payment setup is temporarily unavailable.').waitFor();
    assert.equal(await checkoutButton.isEnabled(), true);
    assert.equal(new URL(page.url()).pathname, '/');
  } finally {
    await context.close();
  }
});

test('a cancelled checkout returns to the form without a payment request', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let paymentRequests = 0;
  try {
    await page.route('**/api/**', async (route) => {
      paymentRequests += 1;
      await route.fulfill(json({ error: 'Unexpected payment request' }, 500));
    });
    await page.goto(`${baseUrl}/?cancelled=true&mode=test`);
    await page.getByRole('heading', { name: 'Write Your Resignation Letter' }).waitFor();
    assert.equal(new URL(page.url()).search, '');
    assert.equal(await page.getByText('Sandbox', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Continue to Stripe Checkout' }).isEnabled(), true);
    assert.equal(paymentRequests, 0);
  } finally {
    await context.close();
  }
});

test('an incomplete form explains why checkout did not start beside the button', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Reject analytics' }).click();
    await page.getByRole('button', { name: 'Continue to Stripe Checkout' }).click();
    const alert = page.getByRole('alert');
    await alert.getByText('Please complete the required details and accept the disclaimer before checkout.').waitFor();
    await page.waitForFunction(() => {
      const alert = document.querySelector('[role="alert"]');
      if (!alert) return false;
      const bounds = alert.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
    });
    assert.equal(await page.getByRole('button', { name: 'Continue to Stripe Checkout' }).isEnabled(), true);
  } finally {
    await context.close();
  }
});

test('Google tag is configured with the site measurement ID and loads only after analytics consent', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route('https://www.googletagmanager.com/gtag/js?id=G-HF4121ZYTH', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.goto(baseUrl);
    assert.equal(await page.locator('script[src*="googletagmanager.com/gtag/js"]').count(), 0);
    const initialCommands = await page.evaluate(() => window.dataLayer.map((args) => [args[0], args[1]]));
    assert.equal(initialCommands.some(([command, id]) => command === 'config' && id === 'G-HF4121ZYTH'), true);

    await page.getByRole('button', { name: 'Allow analytics' }).click();
    const loader = page.locator('script[data-ga4-loader]');
    await loader.waitFor({ state: 'attached' });
    assert.equal(await loader.getAttribute('src'), 'https://www.googletagmanager.com/gtag/js?id=G-HF4121ZYTH');
    const commands = await page.evaluate(() => window.dataLayer.map((args) => [args[0], args[1]]));
    assert.equal(commands.filter(([command, id]) => command === 'config' && id === 'G-HF4121ZYTH').length, 1);
  } finally {
    await context.close();
  }
});

test('live configuration displays Live and sends only live-mode checkout requests', async () => {
  const liveUrl = 'http://127.0.0.1:5200';
  const liveServer = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5200', '--strictPort'], {
    env: { ...process.env, STRIPE_MODE: 'live' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  liveServer.stdout.on('data', (chunk) => { output += chunk.toString(); });
  liveServer.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const context = await browser.newContext();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (liveServer.exitCode !== null) break;
      try {
        if ((await fetch(liveUrl)).ok) {
          ready = true;
          break;
        }
      } catch {
        // Wait for Vite to start.
      }
      await sleep(100);
    }
    if (!ready) throw new Error(`Live browser test server did not start: ${output}`);

    const page = await context.newPage();
    let requestedMode;
    await page.route('**/api/checkout', async (route) => {
      requestedMode = route.request().postDataJSON().mode;
      await route.fulfill(json({ error: 'Live checkout deliberately blocked in this test.' }, 503));
    });
    await page.goto(liveUrl);
    assert.equal(await page.getByText('Live', { exact: true }).isVisible(), true);
    await fillLetterForm(page);
    await page.getByRole('button', { name: 'Continue to Stripe Checkout' }).click();
    await page.getByRole('alert').getByText('Live checkout deliberately blocked in this test.').waitFor();
    assert.equal(requestedMode, 'live');
  } finally {
    await context.close();
    liveServer.kill('SIGTERM');
  }
});