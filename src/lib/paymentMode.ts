export type StripeMode = 'test' | 'live';

export function normalizeStripeMode(value: string | null | undefined): StripeMode {
  return value === 'live' ? 'live' : 'test';
}

export function isCheckoutEnabled(
  flag: string | undefined,
  supabaseUrl: string | undefined,
  anonKey: string | undefined,
): boolean {
  return flag === 'true' && Boolean(supabaseUrl?.trim() && anonKey?.trim());
}