import type { StripeMode } from '@/lib/paymentMode';

export function PaymentModeIndicator({ mode }: { mode: StripeMode }) {
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
      mode === 'live'
        ? 'bg-red-100 text-red-800'
        : 'bg-amber-100 text-amber-900'
    }`}>
      {mode === 'live' ? 'Live Payments' : 'Sandbox'}
    </span>
  );
}