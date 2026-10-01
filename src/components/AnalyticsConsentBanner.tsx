/**
 * Small, persistent Google Analytics preference control.
 *
 * Consent is read through the analytics helper, which also controls whether
 * events can be sent; this component only records and reflects the user's choice.
 */
import { useState } from 'react';
import {
  getAnalyticsConsent,
  setAnalyticsConsent,
  trackEvent,
  trackPageView,
} from '@/lib/analytics';

// Present the stored preference or the initial consent choice as appropriate.
export function AnalyticsConsentBanner() {
  // null means the visitor has not chosen yet; granted/denied values are persisted by the shared helper.
  const [consent, setConsent] = useState(getAnalyticsConsent);
  // Show the full prompt only until a choice is made; afterward retain a small way to reopen settings.
  const [open, setOpen] = useState(consent === null);

  if (!open) {
    // This compact control keeps the saved choice changeable without repeating the full prompt.
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-md hover:bg-slate-50"
      >
        Analytics settings
      </button>
    );
  }

  /**
   * Persist the preference before updating the view so future analytics calls
   * observe the same decision. A page view is sent only after explicit consent.
   */
  function choose(granted: boolean) {
    setAnalyticsConsent(granted);
    setConsent(granted ? 'granted' : 'denied');
    setOpen(false);
    if (granted) {
      trackEvent('analytics_consent_accepted');
      trackPageView(window.location.pathname, document.title);
    }
  }

  return (
    <aside
      aria-label="Analytics preferences"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl sm:flex sm:items-center sm:justify-between sm:gap-6"
    >
      {/* The labelled aside groups the explanation with the two explicit consent actions. */}
      {/* State plainly what is measured and what personal content is excluded. */}
      <div className="mb-4 sm:mb-0">
        <h2 className="font-semibold text-slate-900">Optional analytics</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">
          Allow Google Analytics to measure page views and feature usage. Names, company details,
          and letter text are never sent. You can change this choice at any time.
        </p>
      </div>
      {/* Separate reject and allow buttons make the consent choice deliberate and reversible. */}
      <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => choose(false)}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Reject analytics
        </button>
        <button
          type="button"
          onClick={() => choose(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Allow analytics
        </button>
      </div>
    </aside>
  );
}