/** Supported payment environments; live mode must be selected deliberately. */
export type StripeMode = 'test' | 'live';

/**
 * Normalize build-time mode input to a safe, supported value.
 * Unknown and missing values stay in test mode to avoid accidental live charges.
 */
export function normalizeStripeMode(value: string | null | undefined): StripeMode {
  return value === 'live' ? 'live' : 'test';
}
