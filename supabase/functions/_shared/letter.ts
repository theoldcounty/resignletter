/**
 * Historical validation contract for the Supabase Edge Functions below.
 * The current Express app uses its own request validation; this helper is not
 * imported by the active server path.
 */

/** Normalized fields accepted by the old checkout endpoint. */
export interface LetterInput {
  managerName: string;
  company: string;
  lastDay: string;
  reason: string | null;
  tone: 'grateful' | 'professional' | 'direct';
}

/**
 * Narrows an untrusted JSON value to the fields the historic checkout flow
 * stores and sends to the letter generator. Invalid input returns null.
 */
export function parseLetterInput(value: unknown): LetterInput | null {
  if (!value || typeof value !== 'object') return null;
  // The request starts as unknown; trim free-text fields once here so every
  // downstream database write and prompt sees the same normalized values.
  const form = value as Record<string, unknown>;
  const managerName = typeof form.managerName === 'string' ? form.managerName.trim() : '';
  const company = typeof form.company === 'string' ? form.company.trim() : '';
  const lastDay = typeof form.lastDay === 'string' ? form.lastDay : '';
  const reason = typeof form.reason === 'string' ? form.reason.trim() : '';
  const tone = form.tone;

  // Bound user-controlled lengths and constrain tone to the prompt's supported
  // vocabulary before persisting or forwarding any supplied text.
  if (!managerName || managerName.length > 120 || !company || company.length > 160) return null;
  if (reason.length > 1000) return null;
  if (tone !== 'grateful' && tone !== 'professional' && tone !== 'direct') return null;

  // The regex checks the wire format; the UTC round-trip also rejects impossible
  // calendar dates such as February 30, which a shape check alone would accept.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return null;
  const date = new Date(`${lastDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== lastDay) return null;

  // Store an omitted/blank optional reason consistently as null.
  return { managerName, company, lastDay, reason: reason || null, tone };
}