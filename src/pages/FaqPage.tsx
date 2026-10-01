/** Answers common questions using only the payment and letter-delivery behavior in the app. */
import { useEffect } from 'react';
import { ArrowRight, ChevronDown, CircleHelp } from 'lucide-react';
import { SitePageLayout } from '@/components/SiteChrome';

const questions = [
  {
    question: 'What does ResignLetter do?',
    answer:
      'ResignLetter creates an AI-generated resignation-letter draft from the details you provide. You can choose a grateful, professional, or direct tone.',
  },
  {
    question: 'How does it work?',
    answer:
      'Enter the requested work details, choose a tone, and continue to Stripe Checkout. After the payment is verified, the app generates and displays your letter.',
  },
  {
    question: 'How much does a letter cost?',
    answer:
      'The current price is a one-time £1 per letter. There is no subscription.',
  },
  {
    question: 'What can I do with the finished letter?',
    answer:
      'Review it, copy it, or download it as a plain-text TXT file or a print-ready PDF. The downloaded files use a timestamped filename.',
  },
  {
    question: 'Can I edit the letter on the site?',
    answer:
      'The result page provides copy and download actions rather than an in-page editor. You can edit the copied or downloaded draft in your own document editor.',
  },
  {
    question: 'Is this legal advice?',
    answer:
      'No. The letter is AI-generated for informational purposes only. Review and edit it for your circumstances before sending it.',
  },
  {
    question: 'Who handles the payment?',
    answer:
      'Payment is handled in Stripe Checkout. ResignLetter does not ask you to enter card details into the letter form.',
  },
];

export function FaqPage() {
  // Set a useful browser-tab title when this direct URL is opened or refreshed.
  useEffect(() => {
    document.title = 'FAQ | ResignLetter';
  }, []);

  return (
    <SitePageLayout activePage="faq">
      <div className="max-w-4xl mx-auto px-4 py-14 sm:py-20">
        <section className="max-w-2xl mb-10">
          <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
            <CircleHelp className="w-4 h-4" aria-hidden="true" />
            Help
          </p>
          <h1 className="mt-4 text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">
            Clear answers before you start.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-slate-600">
            What ResignLetter creates, how checkout works, and what to do with your draft.
          </p>
        </section>

        {/* Native details elements keep answers accessible without a separate accordion library. */}
        <section aria-label="Frequently asked questions" className="divide-y divide-slate-200 border-y border-slate-200">
          {questions.map(({ question, answer }) => (
            <details key={question} className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left text-base sm:text-lg font-semibold text-slate-900">
                {question}
                <ChevronDown
                  className="h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <p className="max-w-3xl pb-6 pr-10 text-base leading-relaxed text-slate-600">{answer}</p>
            </details>
          ))}
        </section>

        <section className="mt-12 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Ready to create a draft?</h2>
          <p className="mt-2 text-slate-600">Add your details, choose a tone, and review the result before sending.</p>
          <a
            href="/"
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white transition hover:bg-slate-800"
          >
            Create a letter for £1
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </section>
      </div>
    </SitePageLayout>
  );
}