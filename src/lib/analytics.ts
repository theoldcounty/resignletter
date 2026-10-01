/**
 * Consent-aware Google Analytics boundary for the browser app.
 *
 * Keep analytics optional: events and the GA script are suppressed until a
 * visitor grants consent, and analytics failures must not affect letter flows.
 */
// Restrict event payloads to simple values so callers do not accidentally pass
// nested form data or other user content to the analytics provider.
export type AnalyticsValue = string | number | boolean;
export type AnalyticsProperties = Record<string, AnalyticsValue>;

// `null` means the visitor has not made a choice yet; it is not equivalent to
// either an explicit denial or permission to track.
export type AnalyticsConsent = 'granted' | 'denied' | null;

// A stable key lets a decision survive reloads without server-side identity.
const CONSENT_STORAGE_KEY = 'resignletter.analytics-consent';

// Vite injects this public measurement ID at build time. It identifies the
// analytics property; it is not a secret or a credential.
const GA_MEASUREMENT_ID = typeof import.meta.env === 'undefined'
  ? ''
  : import.meta.env.VITE_GA_MEASUREMENT_ID;

// Avoid asking the browser to append the GA loader more than once per page.
let gaScriptRequested = false;

// Google installs `gtag` at runtime, so describe its optional global to
// TypeScript without making analytics a required dependency of application code.
declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/** Read a valid saved choice, returning `null` when storage is unavailable or unset. */
export function getAnalyticsConsent(): AnalyticsConsent {
  // This guard also keeps this helper safe if it is imported during server rendering.
  if (typeof window === 'undefined') return null;

  try {
    const value = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    // Ignore stale or hand-edited values rather than interpreting them as consent.
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    // Browsers can disable storage; treat that like no saved choice.
    return null;
  }
}

/** Persist a visitor's choice and notify GA if it is already present. */
export function setAnalyticsConsent(granted: boolean): void {
  // There is no browser storage or analytics SDK to update outside the browser.
  if (typeof window === 'undefined') return;

  // Store only the decision; do not put identity or letter contents in storage.
  const value = granted ? 'granted' : 'denied';
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
    // Update consent mode before loading GA so the SDK receives the visitor's choice.
    window.gtag?.('consent', 'update', {
      analytics_storage: granted ? 'granted' : 'denied',
    });
    // A newly granted choice is the only path that starts loading the GA script.
    if (granted) initializeGoogleAnalytics();
  } catch {
    // Analytics consent must never block the app.
  }
}

/** Add the Google tag script only after consent and only when a public ID is configured. */
function initializeGoogleAnalytics(): void {
  // Do not load third-party tracking on the server or in builds without analytics.
  if (typeof window === 'undefined' || !GA_MEASUREMENT_ID) return;

  if (!gaScriptRequested && typeof document !== 'undefined' && document.head) {
    // The DOM check protects against duplicate tags if another bootstrap path
    // has already inserted this loader.
    if (!document.querySelector('script[data-ga4-loader]')) {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
      script.dataset.ga4Loader = 'true';
      document.head.appendChild(script);
    }
    // Mark it requested even if another path supplied the element.
    gaScriptRequested = true;
  }
}

/** Re-apply a prior decision during startup, before page events are sent. */
export function applySavedAnalyticsConsent(): void {
  // Avoid browser globals during server-side imports or static rendering.
  if (typeof window === 'undefined') return;
  const consent = getAnalyticsConsent();
  // No stored decision means analytics stays at its default, non-consenting state.
  if (consent === null) return;

  try {
    window.gtag?.('consent', 'update', {
      analytics_storage: consent,
    });
    // Loading the script is allowed only for an explicit prior grant.
    if (consent === 'granted') initializeGoogleAnalytics();
  } catch {
    // Analytics must never break the app.
  }
}

/** Return GA's client identifier only after consent, for integrations that need it. */
export function getAnalyticsClientId(): string | null {
  // The cookie is a tracking identifier, so never expose it before permission.
  if (getAnalyticsConsent() !== 'granted' || typeof document === 'undefined') return null;

  try {
    const match = document.cookie.match(/(?:^|;\s*)_ga=([^;]+)/);
    if (!match) return null;
    // GA cookies contain dot-separated version/domain/client fields; return the
    // client portion in the format expected by downstream integrations.
    const parts = decodeURIComponent(match[1]).split('.');
    return parts.length >= 4 ? `${parts[2]}.${parts.slice(3).join('.')}` : null;
  } catch {
    // A malformed cookie is not a reason to interrupt the user-facing flow.
    return null;
  }
}

/** Send a GA event only with prior consent; callers should pass non-sensitive metadata. */
export function trackEvent(name: string, properties: AnalyticsProperties = {}): void {
  // Recheck at send time so a later denial immediately stops subsequent events.
  if (getAnalyticsConsent() !== 'granted' || typeof window === 'undefined') return;

  try {
    window.gtag?.('event', name, properties);
  } catch {
    // Analytics must never break the app.
  }
}

/** Send a route view while stripping query and fragment data that may contain user input. */
export function trackPageView(path: string, title: string): void {
  // Do not emit route information until the visitor has chosen to allow analytics.
  if (getAnalyticsConsent() !== 'granted' || typeof window === 'undefined') return;

  try {
    // Query strings and fragments can carry private form data or tokens; report
    // only the stable path rather than forwarding those values to GA.
    const safePath = path.split(/[?#]/, 1)[0] || '/';
    window.gtag?.('event', 'page_view', {
      page_path: safePath,
      page_title: title,
      page_location: `${window.location.origin}${safePath}`,
    });
  } catch {
    // Analytics must never break the app.
  }
}