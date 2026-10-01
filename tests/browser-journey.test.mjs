// End-to-end browser checks run the real Vite app in an isolated Chromium context.
// Playwright routes replace Stripe and app APIs at the network boundary, so the UI can be
// exercised safely without charging cards, creating letters, or sending analytics externally.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

// Separate test/live ports let each browser observe a process launched with one fixed environment.
const baseUrl = 'http://127.0.0.1:5199';
// These handles are shared with the test hooks so every process is closed after the suite.
let server;
let browser;
// Preserve startup output so a readiness timeout explains the actual launch failure.
let serverOutput = '';

before(async () => {
  // Run Vite as a child process with sandbox mode explicitly selected for this suite.
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], {
    env: {
      ...process.env,
      STRIPE_MODE: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  // Poll rather than assuming process creation means the HTTP server is ready.
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

  // Playwright drives real browser semantics while using the workspace-provided Chromium binary.
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});

after(async () => {
  // Close browser resources and stop Vite even when an assertion fails.
  await browser?.close();
  server?.kill('SIGTERM');
});

async function fillLetterForm(page) {
  // Each checkout flow starts with analytics declined and all required form/disclaimer inputs valid.
  await page.getByRole('button', { name: 'Reject analytics' }).click();
  await page.getByLabel('Your Name').fill('Taylor Employee');
  await page.locator('input[placeholder="e.g. Sarah Johnson"]').fill('Alex Manager');
  await page.locator('input[placeholder="e.g. Acme Corporation"]').fill('Example Ltd');
  await page.locator('input[type="date"]').fill('2026-10-30');
  await page.locator('input[type="checkbox"]').check();
}

function json(body, status = 200) {
  // Match the JSON response shape consumed by fetch while keeping API stubs concise.
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

test('sandbox form reaches checkout, returns a paid letter, and supports download', async () => {
  // A fresh browser context isolates cookies, storage, and consent state from other journeys.
  const context = await browser.newContext();
  const page = await context.newPage();
  // Capture request bodies at each trust boundary to confirm the browser sends only its intended IDs/mode.
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
      await route.fulfill(json({
        letter: 'Dear Alex Manager,\n\nI am resigning from Example Ltd.\n\nSincerely,\nTaylor Employee',
        details: {
          senderName: 'Taylor Employee',
          homeAddress: '12 Sample Road\nLondon',
          officeAddress: 'Office House\nLondon',
          generatedAt: '2026-09-27T12:00:00Z',
        },
      }));
    });
    // This minimal checkout document stands in for Stripe's hosted redirect without contacting Stripe.
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
    await page.getByLabel('Home Address').fill('12 Sample Road\nLondon');
    await page.getByLabel('Office Address').fill('Office House\nLondon');
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
    assert.equal(checkoutRequests[0].form.senderName, 'Taylor Employee');
    assert.equal(checkoutRequests[0].form.homeAddress, '12 Sample Road\nLondon');
    assert.equal(checkoutRequests[0].form.officeAddress, 'Office House\nLondon');
    assert.equal(await page.getByText('27 September 2026').isVisible(), true);
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
    await page.getByRole('button', { name: 'Download TXT' }).click();
    assert.match(
      (await downloaded).suggestedFilename(),
      /^resign-letter--\d{4}-\d{2}-\d{2}--\d{2}-\d{2}-\d{2}\.txt$/,
    );
    const pdfEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    const pdfDownload = await pdfEvent;
    assert.match(
      pdfDownload.suggestedFilename(),
      /^resign-letter--\d{4}-\d{2}-\d{2}--\d{2}-\d{2}-\d{2}\.pdf$/,
    );
    assert.equal((await readFile(await pdfDownload.path())).subarray(0, 5).toString(), '%PDF-');
  } finally {
    await context.close();
  }
});

// Simulate sequential provider failures to ensure retries reuse the paid return link rather than charge again.
test('failed verification and generation retain the return link for retry without another checkout', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let verifications = 0;
  let generations = 0;
  let newCheckouts = 0;
  try {
    // Return a recoverable failure once from verification and generation, then let the same return link succeed.
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
          : json({
            letter: 'Dear Alex Manager,\n\nPlease accept my resignation.\n\nSincerely,\nTaylor Employee',
            details: { senderName: 'Taylor Employee', homeAddress: null, officeAddress: null, generatedAt: '2026-09-27T12:00:00Z' },
          }),
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

test('confirmed refund is shown clearly and a refunded checkout cannot request another letter', async () => {
  // A confirmed refund is terminal: the UI must communicate it and suppress an unsafe generation retry.
  const context = await browser.newContext();
  const page = await context.newPage();
  let generations = 0;
  try {
    // Stub verification as successful; the generation endpoint is the authority reporting refund completion.
    await page.route('**/api/verify-payment', (route) => route.fulfill(json({ verified: true, mode: 'test' })));
    await page.route('**/api/generate-letter', (route) => {
      generations += 1;
      return route.fulfill(json({
        error: 'We could not create your letter. Refund confirmed by Stripe; it may take several business days to appear on your card.',
        refundStatus: 'refunded',
      }, 503));
    });
    await page.goto(`${baseUrl}/?session_id=cs_test_refunded&letter_id=letter-789&mode=test`);
    await page.getByRole('heading', { name: 'Refund confirmed' }).waitFor();
    assert.match(await page.getByRole('alert').innerText(), /refund confirmed by Stripe/i);
    assert.equal(await page.getByRole('button', { name: 'Retry getting my letter' }).count(), 0);
    assert.equal(generations, 1);
  } finally {
    await context.close();
  }
});

test('checkout setup errors show a failure and allow another attempt', async () => {
  // A server-side setup error should surface accessibly without locking the form or navigating away.
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
  // Cancellation is a navigation outcome, not a payment event; fail any API call to catch accidental work.
  const context = await browser.newContext();
  const page = await context.newPage();
  // Count all API traffic, rather than only checkout requests, to guard the complete cancellation boundary.
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
  // Invalid input should produce a visible, in-viewport explanation instead of a silent no-op.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Reject analytics' }).click();
    await page.getByRole('button', { name: 'Continue to Stripe Checkout' }).click();
    // Check actual geometry as well as text so the alert is not hidden below or outside the viewport.
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
  // Intercept the vendor script: consent behavior is exercised without contacting Google.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route('https://www.googletagmanager.com/gtag/js?id=G-HF4121ZYTH', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.goto(baseUrl);
    // The command queue may be configured before consent, but the external loader must remain absent.
    assert.equal(await page.locator('script[src*="googletagmanager.com/gtag/js"]').count(), 0);
    const initialCommands = await page.evaluate(() => window.dataLayer.map((args) => [args[0], args[1]]));
    assert.equal(initialCommands.some(([command, id]) => command === 'config' && id === 'G-HF4121ZYTH'), true);

    await page.getByRole('button', { name: 'Allow analytics' }).click();
    // Consent appends the loader exactly once and preserves the configured measurement ID.
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
  // A separate process prevents sandbox environment from leaking into the live-mode UI assertions.
  const liveUrl = 'http://127.0.0.1:5200';
  const liveServer = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5200', '--strictPort'], {
    env: { ...process.env, STRIPE_MODE: 'live' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Keep the live process' output separate so its startup diagnostic is not confused with the sandbox server.
  let output = '';
  liveServer.stdout.on('data', (chunk) => { output += chunk.toString(); });
  liveServer.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const context = await browser.newContext();
  try {
    // Wait for the live-configured server independently so startup failures include its own output.
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
    // Block checkout after recording its mode; this proves routing without initiating any payment.
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

test('FAQ and showcase routes render directly and keep the footer navigation available', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Direct navigation verifies the production-style path fallback, not only in-page link clicks.
    await page.goto(`${baseUrl}/faq`);
    await page.getByRole('heading', { name: 'Clear answers before you start.' }).waitFor();
    assert.equal(await page.title(), 'FAQ | ResignLetter');
    assert.equal(await page.getByRole('link', { name: 'FAQ' }).getAttribute('aria-current'), 'page');
    assert.equal(await page.getByRole('link', { name: 'Showcase' }).getAttribute('href'), '/showcase');

    // The native disclosure row exposes the confirmed £1 one-time price when opened.
    const pricingAnswer = page.locator('details').filter({ hasText: 'How much does a letter cost?' });
    await pricingAnswer.locator('summary').click();
    assert.match(await pricingAnswer.innerText(), /one-time £1 per letter/i);

    // The showcase tone selector demonstrates the three supported options without claiming to be a customer result.
    await page.goto(`${baseUrl}/showcase`);
    await page.getByRole('heading', { name: 'A clearer first draft, shaped around your details.' }).waitFor();
    assert.equal(await page.title(), 'Showcase | ResignLetter');
    assert.equal(await page.getByRole('link', { name: 'Showcase' }).getAttribute('aria-current'), 'page');
    await page.getByRole('button', { name: /Direct/ }).click();
    assert.match(await page.locator('[aria-live="polite"]').innerText(), /I am writing to resign from my position/);
    assert.equal(await page.getByRole('link', { name: 'FAQ' }).getAttribute('href'), '/faq');
  } finally {
    await context.close();
  }
});