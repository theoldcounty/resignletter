export type StripeMode = 'test' | 'live';

export function normalizeStripeMode(value: string | null | undefined): StripeMode {
  return value === 'live' ? 'live' : 'test';
}
