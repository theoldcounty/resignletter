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
  const calls = installBrowserMock();

  trackPageView('/form', 'Resignation letter');
  trackEvent('form_started');

  assert.equal(getAnalyticsConsent(), null);
  assert.deepEqual(calls, []);
  assert.equal(document.analyticsScripts.length, 0);
});

test('records page views without query-string identifiers after consent', () => {
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
  const calls = installBrowserMock();
  setAnalyticsConsent(false);
  applySavedAnalyticsConsent();

  assert.deepEqual(calls.at(-1), ['consent', 'update', { analytics_storage: 'denied' }]);
  assert.equal(getAnalyticsConsent(), 'denied');
  assert.equal(document.analyticsScripts.length, 0);
});

test('only shares the GA client ID with consent and when the analytics cookie exists', () => {
  installBrowserMock();
  document.cookie = '_ga=GA1.1.123456.789012; other=value';
  assert.equal(getAnalyticsClientId(), null);

  setAnalyticsConsent(true);
  assert.equal(getAnalyticsClientId(), '123456.789012');
});

test('sends named funnel events without requiring a loaded analytics script', () => {
  const calls = installBrowserMock();
  setAnalyticsConsent(true);
  trackEvent('checkout_started', { mode: 'test' });
  assert.deepEqual(calls.at(-1), ['event', 'checkout_started', { mode: 'test' }]);

  window.gtag = undefined;

  assert.doesNotThrow(() => trackEvent('checkout_started', { mode: 'test' }));
  assert.equal(calls[0][0], 'consent');
});