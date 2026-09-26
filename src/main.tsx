import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AnalyticsConsentBanner } from './components/AnalyticsConsentBanner';
import { applySavedAnalyticsConsent } from './lib/analytics';
import './index.css';

applySavedAnalyticsConsent();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AnalyticsConsentBanner />
  </StrictMode>
);
