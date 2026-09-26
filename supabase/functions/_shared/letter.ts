export interface LetterInput {
  managerName: string;
  company: string;
  lastDay: string;
  reason: string | null;
  tone: 'grateful' | 'professional' | 'direct';
}

export function parseLetterInput(value: unknown): LetterInput | null {
  if (!value || typeof value !== 'object') return null;
  const form = value as Record<string, unknown>;
  const managerName = typeof form.managerName === 'string' ? form.managerName.trim() : '';
  const company = typeof form.company === 'string' ? form.company.trim() : '';
  const lastDay = typeof form.lastDay === 'string' ? form.lastDay : '';
  const reason = typeof form.reason === 'string' ? form.reason.trim() : '';
  const tone = form.tone;

  if (!managerName || managerName.length > 120 || !company || company.length > 160) return null;
  if (reason.length > 1000) return null;
  if (tone !== 'grateful' && tone !== 'professional' && tone !== 'direct') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return null;
  const date = new Date(`${lastDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== lastDay) return null;

  return { managerName, company, lastDay, reason: reason || null, tone };
}