import type { StripeMode } from '@/lib/paymentMode';

interface PaymentModeSelectorProps {
  mode: StripeMode;
  onChange: (mode: StripeMode) => void;
}

export function PaymentModeSelector({ mode, onChange }: PaymentModeSelectorProps) {
  return (
    <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <legend className="px-1 text-sm font-semibold text-slate-800">Payment mode</legend>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-pressed={mode === 'test'}
          onClick={() => onChange('test')}
          className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
            mode === 'test'
              ? 'border-amber-400 bg-amber-50 text-amber-900'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
          }`}
        >
          Test
        </button>
        <button
          type="button"
          aria-pressed={mode === 'live'}
          onClick={() => onChange('live')}
          className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
            mode === 'live'
              ? 'border-red-300 bg-red-50 text-red-800'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
          }`}
        >
          Live
        </button>
      </div>
      <p role="status" className={`mt-3 text-xs ${mode === 'live' ? 'text-red-700' : 'text-amber-800'}`}>
        {mode === 'live'
          ? 'Live mode can charge real money. Use only after the live Stripe key is configured.'
          : 'Test mode only — no real charges will be made.'}
      </p>
    </fieldset>
  );
}