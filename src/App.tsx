/**
 * Browser-side controller and views for the resignation-letter journey.
 *
 * React owns transient form and display state; payment, persistence, and
 * generation are delegated to the server API. Stripe return parameters are
 * treated only as lookup hints and are verified by the server before delivery.
 * The small helpers below connect that flow to consent-aware analytics,
 * PDF/TXT downloads, and the shared payment-mode configuration.
 */
// React hooks keep the multi-step journey client-side without introducing a separate state framework.
import { useState, useEffect, useCallback, useRef } from 'react';
// Reuse the shared form contract so every controlled field has the same typed shape.
import type { LetterFormData } from '@/lib/letter';
// The analytics wrapper applies the visitor's consent before events are sent.
import { getAnalyticsClientId, trackEvent, trackPageView } from '@/lib/analytics';
// Small shared UI cue keeps the payment environment visible before checkout.
import { PaymentModeIndicator } from '@/components/PaymentModeIndicator';
// Share brand navigation and the FAQ/showcase footer across all app states.
import { SiteFooter, SiteHeader } from '@/components/SiteChrome';
// Normalize client configuration and type-check the mode sent back by Stripe.
import { normalizeStripeMode, type StripeMode } from '@/lib/paymentMode';
// Centralize document formatting so the preview, TXT export, and PDF share the same letter details.
import {
  createLetterDownloadFilename,
  downloadLetterPdf,
  formatLetterDate,
  formatLetterText,
  type LetterDetails,
} from '@/lib/letterDocument';
// lucide-react supplies consistent SVG icons as React components without image assets.
import { FileText, Briefcase, Calendar, User, MessageSquare, Sparkles, Copy, Download, Check, ArrowRight, Shield, RotateCcw, Loader2 } from 'lucide-react';

// Keep the major screens explicit so each payment transition renders one clear state.
type Step = 'form' | 'processing' | 'output';
// These values match the tone options sent with the shared letter form.
type Tone = 'grateful' | 'professional' | 'direct';
// These identifiers come from Stripe's return URL; they are not proof of payment.
type PaymentReturn = { letterId: string; sessionId: string; mode: StripeMode };
// Delivery errors distinguish a confirmed refund from an in-progress or unknown outcome.
type RefundStatus = 'refunded' | 'pending' | 'unconfirmed';

// Preserve refund information from delivery failures so the return screen can give accurate next steps.
class LetterDeliveryError extends Error {
  constructor(message: string, readonly refundStatus: RefundStatus | null = null) {
    super(message);
  }
}

// Drive the tone selector from one typed list so labels and submitted values stay aligned.
const TONES: { value: Tone; label: string; description: string }[] = [
  { value: 'grateful', label: 'Grateful', description: 'Warm and appreciative' },
  { value: 'professional', label: 'Professional', description: 'Formal and neutral' },
  { value: 'direct', label: 'Direct', description: 'Straight to the point' },
];

// Normalize the build-time setting once; the same mode is sent through checkout and return verification.
const PAYMENT_MODE = normalizeStripeMode(import.meta.env.VITE_STRIPE_MODE);

/**
 * Ask the server to deliver the paid letter.
 *
 * The browser never generates the paid result itself: the endpoint checks the
 * checkout session and owns fulfillment/refund decisions. Validate the response
 * shape here as well, so malformed API payloads do not become a blank result.
 */
async function generateLetter(id: string, sessionId: string, mode: StripeMode): Promise<{ letter: string; details: LetterDetails }> {
  trackEvent('letter_generation_started');
  const response = await fetch('/api/generate-letter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ letterId: id, sessionId, mode }),
  });

  if (!response.ok) {
    trackEvent('letter_generation_failed');
    const errData = await response.json().catch(() => ({}));
    throw new LetterDeliveryError(errData.error || 'Letter generation failed. Please retry.', errData.refundStatus || null);
  }

  const data = await response.json();
  if (typeof data.letter !== 'string' || !data.letter.trim()) {
    trackEvent('letter_generation_failed');
    throw new Error('No letter content returned. Please retry.');
  }

  trackEvent('letter_generation_succeeded');
  if (!data.details || typeof data.details.senderName !== 'string') {
    throw new Error('Letter details were not returned. Please retry.');
  }
  return { letter: data.letter, details: data.details };
}

// Coordinate the form, hosted-checkout return, delivery status, and final document view.
export default function App() {
  // Selects the form, in-flight, or delivered-letter view.
  const [step, setStep] = useState<Step>('form');
  // Controlled field values are the single source for validation and the checkout request.
  const [formData, setFormData] = useState<LetterFormData>({
    senderName: '',
    managerName: '',
    company: '',
    lastDay: '',
    reason: '',
    homeAddress: '',
    officeAddress: '',
    tone: 'professional',
  });
  // Map field names to short messages so each input can show its own validation result.
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Separate legal-disclaimer acceptance from the letter fields because it gates checkout.
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  // Prevent duplicate checkout submissions while the API request is in flight.
  const [loading, setLoading] = useState(false);
  // One visible error channel is shared by validation, networking, and document actions.
  const [error, setError] = useState<string | null>(null);

  // Keep the delivered content separate from the input form so output actions need no form reconstruction.
  const [letter, setLetter] = useState<string | null>(null);
  const [letterDetails, setLetterDetails] = useState<LetterDetails | null>(null);

  // Keep backend refund state separate so the recovery copy and retry controls agree.
  const [refundStatus, setRefundStatus] = useState<RefundStatus | null>(null);
  // Briefly swap the copy button label after the clipboard promise succeeds.
  const [copied, setCopied] = useState(false);
  // Retain Stripe correlation values after a failed delivery so retry does not create another checkout.
  const [paymentReturn, setPaymentReturn] = useState<PaymentReturn | null>(null);

  // Refs hold session flags and a DOM target without scheduling renders when those values change.
  // Prevent repeated "form started" events while focus moves between fields.
  const formStarted = useRef(false);
  // Guard the initial URL check against duplicate effect execution in development.
  const handledInitialQuery = useRef(false);
  // Lets the error-scroll effect target the visible form alert.
  const errorRef = useRef<HTMLDivElement>(null);

  // Bring asynchronous errors into view when they appear on the form or payment-return screen.
  useEffect(() => {
    if (error && step === 'form') {
      errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [error, step]);

  /**
   * Resume delivery from Stripe's return URL or the retry button.
   *
   * Verification happens before generation because query-string values can be
   * edited by a visitor; only the server's Stripe-backed result is authoritative.
   */
  const handlePostPayment = useCallback(async (id: string, sessionId: string, mode: StripeMode) => {
    setStep('processing');
    trackPageView('/payment/processing', 'Payment verification');
    setError(null);
    setRefundStatus(null);
    // Distinguish an unpaid/invalid return from a failure after payment succeeded.
    let paymentVerified = false;
    try {
      // The backend checks the session with Stripe and confirms it belongs to this letter and mode.
      const verificationResponse = await fetch('/api/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          letterId: id,
          sessionId,
          mode,
        }),
      });

      if (!verificationResponse.ok) {
        const errData = await verificationResponse.json().catch(() => ({}));
        throw new Error(errData.error || 'Payment could not be verified.');
      }

      const verification = await verificationResponse.json();
      if (!verification.verified) {
        throw new Error('Payment could not be verified.');
      }

      paymentVerified = true;
      // Fulfill only after verification; the server remains responsible for secure delivery.
      const generated = await generateLetter(id, sessionId, mode);
      setLetter(generated.letter);
      setLetterDetails(generated.details);
      setPaymentReturn(null);
      setStep('output');
      // Remove reusable payment identifiers from the address after successful delivery.
      window.history.replaceState({}, document.title, window.location.pathname);
      trackEvent('payment_succeeded', { mode });
      trackPageView('/letter', 'Your resignation letter');
    } catch (err) {
      // Keep a paid return recoverable if delivery fails, and show any backend refund outcome.
      trackEvent(paymentVerified ? 'payment_return_processing_failed' : 'payment_verification_failed', { mode });
      trackPageView('/payment/verification-failed', 'Payment verification failed');
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setRefundStatus(err instanceof LetterDeliveryError ? err.refundStatus : null);
      setStep('form');
    }
  }, []);

  // Process Stripe's redirect exactly once; React Strict Mode may re-run effects during development.
  useEffect(() => {
    if (handledInitialQuery.current) return;
    handledInitialQuery.current = true;

    // The URL carries only correlation data. handlePostPayment verifies it before any paid action.
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const returnedLetterId = params.get('letter_id');
    const mode = normalizeStripeMode(params.get('mode'));
    const cancelled = params.get('cancelled');

    if (cancelled) {
      // A cancelled checkout returns to the form without creating or delivering a letter.
      trackPageView('/payment/cancelled', 'Payment cancelled');
      trackEvent('payment_cancelled', { mode });
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }

    if (sessionId && returnedLetterId) {
      // Retain the identifiers in state so the user can retry fulfillment without paying again.
      trackPageView('/payment/return', 'Payment return');
      trackEvent('payment_returned', { mode });
      setPaymentReturn({ letterId: returnedLetterId, sessionId, mode });
      void handlePostPayment(returnedLetterId, sessionId, mode);
      return;
    }

    // Record the regular landing view only when this is not a payment return.
    trackPageView('/', 'Resignation letter form');
  }, [handlePostPayment]);

  // Validate required fields locally for quick feedback; the server still validates API input independently.
  function validate(): boolean {
    // Build a fresh map each time so correcting a field also clears its previous message.
    const newErrors: Record<string, string> = {};
    if (!formData.senderName.trim()) newErrors.senderName = 'Required';
    if (!formData.managerName.trim()) newErrors.managerName = 'Required';
    if (!formData.company.trim()) newErrors.company = 'Required';
    if (!formData.lastDay.trim()) newErrors.lastDay = 'Required';
    if (!waiverAccepted) newErrors.waiver = 'You must accept the disclaimer to continue';
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) {
      setError('Please complete the required details and accept the disclaimer before checkout.');
      return false;
    }
    setError(null);
    return true;
  }

  /**
   * Validate the form, create a checkout session through our server, then leave
   * the app for Stripe's hosted payment page. Card details never pass through this form.
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    trackEvent('form_submit_attempt', { mode: PAYMENT_MODE });
    if (!validate()) {
      trackEvent('form_validation_failed');
      return;
    }

    trackEvent('form_submitted', { mode: PAYMENT_MODE, tone: formData.tone });

    setLoading(true);
    setError(null);

    try {
      // Send the app's normalized mode and optional analytics client ID; never send letter text to analytics.
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form: formData,
          mode: PAYMENT_MODE,
          gaClientId: getAnalyticsClientId(),
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Payment setup failed');
      }

      const checkoutData = await response.json();
      if (checkoutData.url) {
        // The backend creates the session; Stripe hosts the payment form and returns here afterward.
        trackEvent('checkout_session_created', { mode: PAYMENT_MODE });
        trackEvent('checkout_redirect_started', { mode: PAYMENT_MODE });
        window.location.href = checkoutData.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      trackEvent('checkout_flow_failed', { mode: PAYMENT_MODE, stage: 'create_checkout' });
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setLoading(false);
    }
  }

  // Use the browser clipboard API when available and expose a manual-copy fallback on failure.
  function handleCopy() {
    if (!letter) return;
    trackEvent('letter_copy_clicked');

    if (!navigator.clipboard?.writeText) {
      trackEvent('letter_copy_failed');
      return;
    }

    void navigator.clipboard.writeText(letter).then(() => {
      setCopied(true);
      trackEvent('letter_copied');
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setError('Could not copy the letter. Please select and copy the text manually.');
      trackEvent('letter_copy_failed');
    });
  }

  // Build a temporary UTF-8 text file locally so the letter itself need not be uploaded for download.
  function handleDownloadTxt() {
    if (!letter || !letterDetails) return;
    trackEvent('letter_downloaded', { format: 'txt' });
    const blob = new Blob([formatLetterText(letter, letterDetails)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = createLetterDownloadFilename('txt');
    a.click();
    URL.revokeObjectURL(url);
  }

  // Delegate PDF layout/encoding to the shared document helper and report failures in the UI.
  async function handleDownloadPdf() {
    if (!letter || !letterDetails) return;
    try {
      await downloadLetterPdf(letter, letterDetails, createLetterDownloadFilename('pdf'));
      trackEvent('letter_downloaded', { format: 'pdf' });
    } catch {
      setError('Could not create the PDF. Please try again or download the text version.');
    }
  }

  // Reset every form, output, and return value so a new letter starts without stale payment state.
  function handleReset() {
    trackEvent('create_another_letter_clicked');
    setStep('form');
    trackPageView('/', 'Resignation letter form');
    setLetter(null);
    setLetterDetails(null);
    setRefundStatus(null);
    setPaymentReturn(null);
    setFormData({
      senderName: '',
      managerName: '',
      company: '',
      lastDay: '',
      reason: '',
      homeAddress: '',
      officeAddress: '',
      tone: 'professional',
    });
    setWaiverAccepted(false);
    setErrors({});
    setError(null);
    formStarted.current = false;
  }

  // The processing screen is intentionally isolated from the form to make the server round-trip clear.
  if (step === 'processing') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col">
        {/* A single status message avoids exposing internal request details while delivery is in progress. */}
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <Loader2 className="w-12 h-12 text-slate-700 mx-auto mb-4 animate-spin" />
            <h2 className="text-xl font-semibold text-slate-800">Generating your letter...</h2>
            <p className="text-slate-500 mt-2">This will only take a moment.</p>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  // Once delivered, show the returned letter and local copy/download actions instead of checkout controls.
  if (step === 'output') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col">
        <main className="flex-1 py-12 px-4">
          <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 bg-emerald-50 text-emerald-700 px-4 py-2 rounded-full text-sm font-medium mb-4">
              <Check className="w-4 h-4" />
              Letter Generated Successfully
            </div>
            <h1 className="text-3xl font-bold text-slate-900">Your Resignation Letter</h1>
            <p className="text-slate-500 mt-2">Review, copy, or download your professional resignation letter below.</p>
          </div>

          {/* Keep download/copy failures adjacent to the output so they can be corrected without losing the letter. */}
          {error && <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            {/* Actions are client-side exports; the server-generated letter remains the source of truth. */}
            <div className="bg-slate-50 border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-600 text-sm font-medium">
                <FileText className="w-4 h-4" />
                Resignation Letter
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCopy}
                  type="button"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={handleDownloadTxt}
                  type="button"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download TXT
                </button>
                <button
                  onClick={() => void handleDownloadPdf()}
                  type="button"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download PDF
                </button>
              </div>
            </div>
            {/* Format the address/date separately from the letter body to retain document-style layout. */}
            <div className="p-8 sm:p-12 font-serif text-slate-800 leading-relaxed">
              {letterDetails && (
                <>
                  {letterDetails.senderName && <p className="font-semibold">{letterDetails.senderName}</p>}
                  {letterDetails.homeAddress && <p className="whitespace-pre-wrap">{letterDetails.homeAddress}</p>}
                  {letterDetails.generatedAt && <p className="mt-5">{formatLetterDate(letterDetails.generatedAt)}</p>}
                  {letterDetails.officeAddress && <p className="mt-5 whitespace-pre-wrap">{letterDetails.officeAddress}</p>}
                </>
              )}
              <pre className="mt-6 whitespace-pre-wrap font-serif text-base leading-relaxed">{letter}</pre>
            </div>
          </div>

          {/* Starting over clears the old result and all checkout recovery state. */}
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={handleReset}
              type="button"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white border border-slate-300 text-slate-700 font-medium rounded-xl hover:bg-slate-50 transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Create Another Letter
            </button>
          </div>

          {/* Keep the informational/legal disclaimer visible alongside the generated document. */}
          <p className="text-center text-xs text-slate-400 mt-8 max-w-md mx-auto leading-relaxed">
            This letter was generated by AI and is provided for informational purposes only.
            It does not constitute legal advice. Please review and edit before sending.
          </p>
          </div>
        </main>
        <SiteFooter />
      </div>
    );
  }

  // The default screen is the form; a saved return link instead shows payment-recovery guidance.
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100">
      <div className="min-h-screen flex flex-col">
        {/* Persistent identity helps orient the user while keeping the form as the primary task. */}
        <SiteHeader />

        <main className="flex-1 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-xl">
            <div className="text-center mb-8">
              <div className="inline-flex items-center gap-2 bg-slate-100 text-slate-600 px-4 py-2 rounded-full text-sm font-medium mb-4">
                <Sparkles className="w-4 h-4" />
                AI-Powered · Ready in seconds
              </div>
              <h1 className="text-4xl font-bold text-slate-900 tracking-tight">
                Write Your Resignation Letter
              </h1>
              <p className="text-slate-500 mt-3 text-lg">
                Professional, clean, and respectful. No bridges burned.
              </p>
            </div>

            {paymentReturn ? (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8">
                {/* The return URL stays in React state until success or an explicit, confirmed reset. */}
                {error && (
                  <div ref={errorRef} role="alert" className={`mb-6 px-4 py-3 rounded-xl text-sm border ${
                    refundStatus === 'refunded'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : refundStatus === 'pending'
                        ? 'bg-amber-50 border-amber-200 text-amber-800'
                        : 'bg-red-50 border-red-200 text-red-700'
                  }`}>
                    {error}
                  </div>
                )}
                {/* Different copy prevents refunded sessions from being mistaken for reusable checkouts. */}
                <h2 className="text-xl font-semibold text-slate-900">
                  {refundStatus === 'refunded' ? 'Refund confirmed' : refundStatus === 'pending' ? 'Refund in progress' : 'Finish retrieving your letter'}
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  {refundStatus === 'refunded'
                    ? 'Stripe confirmed your refund. It may take several business days to appear on your card. This checkout cannot be used again.'
                    : refundStatus
                      ? 'No letter was delivered. Keep this page open to check the refund status; do not pay again until it is resolved.'
                      : 'Your checkout return is saved on this page. Retry verification and letter generation without making another payment. If it still fails, keep this page open and contact support.'}
                </p>
                <div className="mt-6 flex flex-col sm:flex-row gap-3">
                  {/* Retrying uses the same verified session rather than creating a second payment. */}
                  {refundStatus !== 'refunded' && <button
                    type="button"
                    onClick={() => void handlePostPayment(paymentReturn.letterId, paymentReturn.sessionId, paymentReturn.mode)}
                    className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800"
                  >
                    {refundStatus ? 'Check refund status' : 'Retry getting my letter'}
                  </button>}
                  <button
                    type="button"
                    onClick={() => {
                      // Preserve the retry path unless the visitor confirms they intend to discard it.
                      if (refundStatus !== 'refunded' &&
                        !window.confirm('Starting over will remove this payment return link. Continue only if you no longer need to retry it.')) return;
                      setPaymentReturn(null);
                      setError(null);
                      window.history.replaceState({}, document.title, window.location.pathname);
                    }}
                    className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Start a new letter
                  </button>
                </div>
              </div>
            ) : (
            <form
              onSubmit={handleSubmit}
              onFocusCapture={() => {
                // Emit the start event once per form session rather than once for every focused field.
                if (!formStarted.current) {
                  formStarted.current = true;
                  trackEvent('form_started');
                }
              }}
              className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8 space-y-6"
            >
              {/* Required identity fields are controlled by React so validation and checkout use one source of data. */}
              <div>
                <label htmlFor="sender-name" className="block text-sm font-medium text-slate-700 mb-2">Your Name</label>
                <input
                  id="sender-name"
                  type="text"
                  maxLength={120}
                  value={formData.senderName}
                  onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                  placeholder="Your full name"
                  className="w-full px-4 py-3 border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                {errors.senderName && <p className="text-red-500 text-xs mt-1">{errors.senderName}</p>}
              </div>
              {/* Manager identity identifies the recipient of the resignation letter. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Manager's Name
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={formData.managerName}
                    onChange={(e) => setFormData({ ...formData, managerName: e.target.value })}
                    placeholder="e.g. Sarah Johnson"
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-all"
                  />
                </div>
                {errors.managerName && <p className="text-red-500 text-xs mt-1">{errors.managerName}</p>}
              </div>

              {/* Optional postal addresses are included in the document, not in analytics events. */}
              <div>
                <label htmlFor="home-address" className="block text-sm font-medium text-slate-700 mb-2">Home Address <span className="text-slate-400 font-normal">(optional)</span></label>
                <textarea id="home-address" rows={3} maxLength={500} value={formData.homeAddress}
                  onChange={(e) => setFormData({ ...formData, homeAddress: e.target.value })}
                  placeholder="Your address, if you want it on the letter"
                  className="w-full px-4 py-3 border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900" />
              </div>
              <div>
                <label htmlFor="office-address" className="block text-sm font-medium text-slate-700 mb-2">Office Address <span className="text-slate-400 font-normal">(optional)</span></label>
                <textarea id="office-address" rows={3} maxLength={500} value={formData.officeAddress}
                  onChange={(e) => setFormData({ ...formData, officeAddress: e.target.value })}
                  placeholder="Employer's office address, if you want it on the letter"
                  className="w-full px-4 py-3 border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900" />
              </div>

              {/* Employer name identifies the workplace named in the letter. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Company Name
                </label>
                <div className="relative">
                  <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={formData.company}
                    onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                    placeholder="e.g. Acme Corporation"
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-all"
                  />
                </div>
                {errors.company && <p className="text-red-500 text-xs mt-1">{errors.company}</p>}
              </div>

              {/* The requested final day is required so the letter states an unambiguous end date. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Last Working Day
                </label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="date"
                    value={formData.lastDay}
                    onChange={(e) => setFormData({ ...formData, lastDay: e.target.value })}
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-all"
                  />
                </div>
                {errors.lastDay && <p className="text-red-500 text-xs mt-1">{errors.lastDay}</p>}
              </div>

              {/* The reason gives the generator context; it remains in the form request, not analytics events. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Reason <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <div className="relative">
                  <MessageSquare className="absolute left-3 top-4 w-4 h-4 text-slate-400" />
                  <textarea
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    placeholder="e.g. New career opportunity, relocation, personal reasons..."
                    rows={3}
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent transition-all resize-none"
                  />
                </div>
              </div>

              {/* A typed tone choice lets the server shape the letter consistently. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-3">
                  Tone
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {TONES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => {
                        setFormData({ ...formData, tone: t.value });
                        trackEvent('tone_selected', { tone: t.value });
                      }}
                      className={`px-3 py-3 rounded-xl border text-sm font-medium transition-all text-center ${
                        formData.tone === t.value
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <div className="font-semibold">{t.label}</div>
                      <div className={`text-xs mt-0.5 ${formData.tone === t.value ? 'text-slate-300' : 'text-slate-400'}`}>
                        {t.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Require explicit acceptance because the output is AI-generated and not legal advice. */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={waiverAccepted}
                    onChange={(e) => {
                      setWaiverAccepted(e.target.checked);
                      if (e.target.checked) trackEvent('disclaimer_accepted');
                    }}
                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span className="text-xs text-slate-600 leading-relaxed">
                    I understand this letter is AI-generated and does not constitute legal advice.
                    I am responsible for reviewing and editing the letter before sending it to my employer.
                  </span>
                </label>
                {errors.waiver && <p className="text-red-500 text-xs mt-2">{errors.waiver}</p>}
              </div>

              {/* Make the environment visible before the user reaches Stripe's hosted checkout. */}
              <div className="flex justify-center">
                <PaymentModeIndicator mode={PAYMENT_MODE} />
              </div>

              {/* role=alert gives validation and network errors an accessible announcement target. */}
              {error && (
                <div ref={errorRef} role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
                  {error}
                </div>
              )}

              {/* Disable repeat submissions while the server creates a single checkout session. */}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-slate-900 text-white font-semibold py-4 rounded-xl hover:bg-slate-800 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Redirecting to payment...
                  </>
                ) : (
                  <>
                    Continue to Stripe Checkout
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>

              <div className="flex items-center justify-center gap-2 text-xs text-slate-400">
                <Shield className="w-3.5 h-3.5" />
                Secure payment via Stripe
              </div>
            </form>
            )}

            {/* Summarize the user-visible journey without implying that payment itself generates the letter client-side. */}
            <div className="mt-8 grid grid-cols-3 gap-4 text-center">
              <div className="px-2">
                <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-sm font-bold text-slate-600">1</span>
                </div>
                <p className="text-xs text-slate-500">Fill in details</p>
              </div>
              <div className="px-2">
                <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-sm font-bold text-slate-600">2</span>
                </div>
                <p className="text-xs text-slate-500">Stripe checkout</p>
              </div>
              <div className="px-2">
                <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-sm font-bold text-slate-600">3</span>
                </div>
                <p className="text-xs text-slate-500">Get your letter</p>
              </div>
            </div>
          </div>
        </main>

        {/* Keep the product disclaimer available on the form screen as well as the result screen. */}
        <SiteFooter />
      </div>
    </div>
  );
}
