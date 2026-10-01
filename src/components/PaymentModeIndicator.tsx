/**
 * Visible cue for the payment environment configured for this browser build.
 * The mode type comes from the shared normalizer so the indicator cannot drift
 * from the mode sent to the server during checkout.
 */
import type { StripeMode } from '@/lib/paymentMode';

// Keep environment feedback small but prominent because live payments are consequential.
export function PaymentModeIndicator({ mode }: { mode: StripeMode }) {
  // A stronger warning color distinguishes live charges from sandbox testing.
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
      mode === 'live'
        ? 'bg-red-100 text-red-800'
        : 'bg-amber-100 text-amber-900'
    }`}>
      {/* The text label preserves the distinction for screen readers and color-blind users. */}
      {mode === 'live' ? 'Live' : 'Sandbox'}
    </span>
  );
}