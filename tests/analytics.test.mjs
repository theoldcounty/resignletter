// Analytics tests run against the real consent/event helpers but replace browser APIs.
// This keeps consent and privacy behavior testable without loading Google scripts or sending data.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySavedAnalyticsConsent,
  getAnalyticsClientId,
  getAnalyticsConsent,
  setAnalyticsConsent,
  trackEvent,
  trackPageView,
} from '../src/lib/analytics.ts';

// Install only the browser surface analytics.ts consumes; Maps capture persisted consent
// and gtag calls make outgoing analytics payloads directly inspectable.
function installBrowserMock() {
  const calls = [];
  const values = new Map();
  globalThis.document = {
    cookie: '',
    analyticsScripts: [],
    head: {
      appendChild: (script) => globalThis.document.analyticsScripts.push(script),
    },
    createElement: (tagName) => ({ tagName, dataset: {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    location: {
      origin: 'https://resignletter.example',
      pathname: '/payment/return',
      search: '?session_id=private-session&letter_id=private-letter',
    },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    gtag: (...args) => calls.push(args),
  };
  return calls;
}

test('does not track before the user grants analytics consent', () => {
  // A fresh mock starts with no stored choice so the default must remain privacy-safe.
  const calls = installBrowserMock();

  trackPageView('/form', 'Resignation letter');
  trackEvent('form_started');

  assert.equal(getAnalyticsConsent(), null);
  assert.deepEqual(calls, []);
  assert.equal(document.analyticsScripts.length, 0);
});

test('records page views without query-string identifiers after consent', () => {
  // Payment-return query values are sensitive correlation tokens and must not reach analytics.
  const calls = installBrowserMock();
  setAnalyticsConsent(true);
  trackPageView('/payment/return?session_id=private-session', 'Payment return');

  const pageView = calls.find((call) => call[0] === 'event' && call[1] === 'page_view');
  assert.deepEqual(pageView[2], {
    page_path: '/payment/return',
    page_title: 'Payment return',
    page_location: 'https://resignletter.example/payment/return',
  });
  assert.equal(getAnalyticsConsent(), 'granted');
});

test('restores the visitor consent choice for Google Analytics', () => {
  // Saved denial must update Google's consent mode without loading its external script.
  const calls = installBrowserMock();
  setAnalyticsConsent(false);
  applySavedAnalyticsConsent();

  assert.deepEqual(calls.at(-1), ['consent', 'update', { analytics_storage: 'denied' }]);
  assert.equal(getAnalyticsConsent(), 'denied');
  assert.equal(document.analyticsScripts.length, 0);
});

test('only shares the GA client ID with consent and when the analytics cookie exists', () => {
  // The client ID is useful for attribution only when consent and Google's cookie are both present.
  installBrowserMock();
  document.cookie = '_ga=GA1.1.123456.789012; other=value';
  assert.equal(getAnalyticsClientId(), null);

  setAnalyticsConsent(true);
  assert.equal(getAnalyticsClientId(), '123456.789012');
});

test('sends named funnel events without requiring a loaded analytics script', () => {
  // Consent commands are queued before the loader finishes, so event tracking must remain safe.
  const calls = installBrowserMock();
  setAnalyticsConsent(true);
  trackEvent('checkout_started', { mode: 'test' });
  assert.deepEqual(calls.at(-1), ['event', 'checkout_started', { mode: 'test' }]);

  window.gtag = undefined;

  assert.doesNotThrow(() => trackEvent('checkout_started', { mode: 'test' }));
  assert.equal(calls[0][0], 'consent');
});