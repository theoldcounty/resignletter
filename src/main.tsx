/**
 * Browser entry point: restore privacy preferences, then mount the React app
 * and its consent prompt into the single root element in index.html.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppRouter from './AppRouter';
import { AnalyticsConsentBanner } from './components/AnalyticsConsentBanner';
import { applySavedAnalyticsConsent } from './lib/analytics';
// Global styles are imported here so Vite includes them in the app bundle.
import './index.css';

// Apply an existing choice before React can send route or interaction events.
applySavedAnalyticsConsent();

// The non-null assertion relies on index.html providing the app's #root mount point.
createRoot(document.getElementById('root')!).render(
  // StrictMode enables additional development checks without changing production behavior.
  <StrictMode>
    {/* Keep the consent UI alongside the main app so it can be shown on any route. */}
    <AppRouter />
    <AnalyticsConsentBanner />
  </StrictMode>
);
