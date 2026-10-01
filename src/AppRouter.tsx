/**
 * Small path-based page switch for the three public URLs.
 *
 * The server already falls back to index.html for unknown non-API paths, and
 * ordinary links trigger a normal navigation, so React Router is unnecessary.
 */
import App from './App';
import { FaqPage } from './pages/FaqPage';
import { ShowcasePage } from './pages/ShowcasePage';

/** Normalize a trailing slash so /faq and /faq/ resolve to the same page. */
function getCurrentPath(): string {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

export default function AppRouter() {
  const path = getCurrentPath();

  if (path === '/faq') return <FaqPage />;
  if (path === '/showcase') return <ShowcasePage />;

  // Keep the established form as the home page and as the fallback for other paths.
  return <App />;
}