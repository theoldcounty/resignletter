/** An explicitly illustrative preview of the product's supported tones and real output formats. */
import { useEffect, useState } from 'react';
import { ArrowRight, Check, Download, FileText, Sparkles } from 'lucide-react';
import { SitePageLayout } from '@/components/SiteChrome';

const examples = [
  {
    id: 'grateful',
    label: 'Grateful',
    summary: 'Warm and appreciative',
    text: 'Thank you for the opportunities and support I have received during my time at [Company].',
  },
  {
    id: 'professional',
    label: 'Professional',
    summary: 'Formal and neutral',
    text: 'Please accept this letter as formal notice of my resignation from my position at [Company].',
  },
  {
    id: 'direct',
    label: 'Direct',
    summary: 'Straight to the point',
    text: 'I am writing to resign from my position at [Company]. My final working day will be [date].',
  },
] as const;

export function ShowcasePage() {
  const [selectedTone, setSelectedTone] = useState<(typeof examples)[number]['id']>('professional');
  const selectedExample = examples.find((example) => example.id === selectedTone) ?? examples[1];

  // Set a useful browser-tab title when this direct URL is opened or refreshed.
  useEffect(() => {
    document.title = 'Showcase | ResignLetter';
  }, []);

  return (
    <SitePageLayout activePage="showcase">
      <div className="max-w-5xl mx-auto px-4 py-14 sm:py-20">
        <section className="grid gap-10 lg:grid-cols-[1fr_0.85fr] lg:items-center">
          <div>
            <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Product showcase
            </p>
            <h1 className="mt-4 text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">
              A clearer first draft, shaped around your details.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
              Choose a tone, enter the key details, and receive an AI-generated resignation-letter draft to review.
            </p>
            <a
              href="/"
              className="mt-7 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white transition hover:bg-slate-800"
            >
              Create your letter for £1
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
            <p className="mt-3 text-sm text-slate-500">One-time price · No subscription</p>
          </div>

          {/* This sample is clearly labelled so visitors do not mistake it for a customer result. */}
          <section className="rounded-3xl border border-slate-200 bg-white p-5 sm:p-7 shadow-xl shadow-slate-900/5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Illustrative example</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900">Resignation letter</h2>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">Draft</span>
            </div>

            <div role="group" aria-label="Choose an illustrative letter tone" className="mt-6 grid grid-cols-3 gap-2">
              {examples.map((example) => (
                <button
                  key={example.id}
                  type="button"
                  aria-pressed={selectedTone === example.id}
                  onClick={() => setSelectedTone(example.id)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${
                    selectedTone === example.id
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
                  }`}
                >
                  <span className="block text-sm font-semibold">{example.label}</span>
                  <span className={`mt-1 block text-[11px] ${selectedTone === example.id ? 'text-slate-300' : 'text-slate-500'}`}>
                    {example.summary}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-6 rounded-2xl bg-slate-50 p-5 sm:p-6">
              <p className="font-serif text-slate-800">Dear [Manager name],</p>
              <p aria-live="polite" className="mt-4 font-serif text-base leading-7 text-slate-700">
                {selectedExample.text}
              </p>
              <p className="mt-4 font-serif text-slate-800">Yours sincerely,<br />[Your name]</p>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-slate-500">
              Illustrative wording only—not a generated customer letter. Your draft is created from the details and tone you choose.
            </p>
          </section>
        </section>

        <section aria-labelledby="showcase-steps" className="mt-16 sm:mt-24">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">The real workflow</p>
            <h2 id="showcase-steps" className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
              From your details to a draft you can take with you.
            </h2>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                <FileText className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 font-semibold text-slate-900">1. Add your details</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">Enter the people, company, final day, and other details for the letter.</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                <Check className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 font-semibold text-slate-900">2. Choose a tone</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">Select Grateful, Professional, or Direct to guide the draft.</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                <Download className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 font-semibold text-slate-900">3. Review and export</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">Copy the result or download it as TXT or PDF, then review and edit before sending.</p>
            </article>
          </div>
        </section>

        <section className="mt-12 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-900 p-6 text-white sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div>
            <h2 className="text-xl font-semibold">One letter. £1. No subscription.</h2>
            <p className="mt-2 text-sm text-slate-300">The final letter is an AI-generated draft, not legal advice.</p>
          </div>
          <a href="/" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 font-semibold text-slate-900 transition hover:bg-slate-100">
            Start your letter
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </section>
      </div>
    </SitePageLayout>
  );
}