export type AnalyticsValue = string | number | boolean;
export type AnalyticsProperties = Record<string, AnalyticsValue>;
export type AnalyticsConsent = 'granted' | 'denied' | null;

const CONSENT_STORAGE_KEY = 'resignletter.analytics-consent';
const GA_MEASUREMENT_ID = typeof import.meta.env === 'undefined'
  ? ''
  : import.meta.env.VITE_GA_MEASUREMENT_ID;

let gaScriptRequested = false;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export function getAnalyticsConsent(): AnalyticsConsent {
  if (typeof window === 'undefined') return null;

  try {
    const value = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

export function setAnalyticsConsent(granted: boolean): void {
  if (typeof window === 'undefined') return;

  const value = granted ? 'granted' : 'denied';
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
    window.gtag?.('consent', 'update', {
      analytics_storage: granted ? 'granted' : 'denied',
    });
    if (granted) initializeGoogleAnalytics();
  } catch {
    // Analytics consent must never block the app.
  }
}

function initializeGoogleAnalytics(): void {
  if (typeof window === 'undefined' || !GA_MEASUREMENT_ID) return;

  if (!gaScriptRequested && typeof document !== 'undefined' && document.head) {
    if (!document.querySelector('script[data-ga4-loader]')) {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
      script.dataset.ga4Loader = 'true';
      document.head.appendChild(script);
    }
    gaScriptRequested = true;
  }
}

export function applySavedAnalyticsConsent(): void {
  if (typeof window === 'undefined') return;
  const consent = getAnalyticsConsent();
  if (consent === null) return;

  try {
    window.gtag?.('consent', 'update', {
      analytics_storage: consent,
    });
    if (consent === 'granted') initializeGoogleAnalytics();
  } catch {
    // Analytics must never break the app.
  }
}

export function getAnalyticsClientId(): string | null {
  if (getAnalyticsConsent() !== 'granted' || typeof document === 'undefined') return null;

  try {
    const match = document.cookie.match(/(?:^|;\s*)_ga=([^;]+)/);
    if (!match) return null;
    const parts = decodeURIComponent(match[1]).split('.');
    return parts.length >= 4 ? `${parts[2]}.${parts.slice(3).join('.')}` : null;
  } catch {
    return null;
  }
}

export function trackEvent(name: string, properties: AnalyticsProperties = {}): void {
  if (getAnalyticsConsent() !== 'granted' || typeof window === 'undefined') return;

  try {
    window.gtag?.('event', name, properties);
  } catch {
    // Analytics must never break the app.
  }
}

export function trackPageView(path: string, title: string): void {
  if (getAnalyticsConsent() !== 'granted' || typeof window === 'undefined') return;

  try {
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