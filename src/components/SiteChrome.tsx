/**
 * Shared page frame for the form and informational routes.
 *
 * Keeping the brand header and footer in one place makes the FAQ and showcase
 * reachable from every page without adding a routing or navigation dependency.
 */
import type { ReactNode } from 'react';
import { FileText } from 'lucide-react';

type InformationalPage = 'faq' | 'showcase';

/** Brand link shared by the product form and the informational pages. */
export function SiteHeader() {
  return (
    <header className="border-b border-slate-200/60 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
        <a href="/" aria-label="ResignLetter home" className="flex items-center gap-2">
          <span className="w-9 h-9 bg-slate-900 rounded-lg flex items-center justify-center">
            <FileText className="w-5 h-5 text-white" aria-hidden="true" />
          </span>
          <span className="font-semibold text-slate-900 text-lg">ResignLetter</span>
        </a>
        <span className="text-sm text-slate-500 hidden sm:block">AI Resignation Letter Generator</span>
      </div>
    </header>
  );
}

/** Footer links and the AI/legal disclaimer used consistently across routes. */
export function SiteFooter({ activePage }: { activePage?: InformationalPage }) {
  return (
    <footer className="border-t border-slate-200/60 bg-white/80">
      <div className="max-w-5xl mx-auto px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs text-slate-400 text-center sm:text-left">
          ResignLetter — AI-generated resignation letters. Not legal advice.
        </p>
        <nav aria-label="Helpful pages" className="flex items-center gap-5">
          <a
            href="/faq"
            aria-current={activePage === 'faq' ? 'page' : undefined}
            className="text-sm text-slate-600 hover:text-slate-900 underline-offset-4 hover:underline"
          >
            FAQ
          </a>
          <a
            href="/showcase"
            aria-current={activePage === 'showcase' ? 'page' : undefined}
            className="text-sm text-slate-600 hover:text-slate-900 underline-offset-4 hover:underline"
          >
            Showcase
          </a>
        </nav>
      </div>
    </footer>
  );
}

/** Give stand-alone information pages the same header, footer, and minimum height as the app. */
export function SitePageLayout({
  children,
  activePage,
}: {
  children: ReactNode;
  activePage: InformationalPage;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter activePage={activePage} />
    </div>
  );
}