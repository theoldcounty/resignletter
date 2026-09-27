import { Pool } from 'pg';
import type { LetterInput, StripeMode } from './payment';

export type LetterRecord = {
  id: string;
  manager_name: string;
  company: string;
  last_day: string;
  reason: string | null;
  tone: LetterInput['tone'];
  payment_mode: StripeMode;
  payment_status: string;
  stripe_session_id: string | null;
  letter_text: string | null;
};

let pool: Pool | undefined;

function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('Database is not configured.');
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export const storage = {
  async createPendingLetter(form: LetterInput, mode: StripeMode, gaClientId?: string): Promise<string> {
    const result = await database().query<{ id: string }>(
      `INSERT INTO public.resignation_letters
        (manager_name, company, last_day, reason, tone, payment_mode, payment_status, ga_client_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [form.managerName, form.company, form.lastDay, form.reason, form.tone, mode, gaClientId ?? null],
    );
    if (!result.rows[0]) throw new Error('Could not save letter details.');
    return result.rows[0].id;
  },

  async setCheckoutSession(letterId: string, sessionId: string): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET stripe_session_id = $2, updated_at = now()
       WHERE id = $1 AND payment_status = 'pending'`,
      [letterId, sessionId],
    );
    return result.rowCount === 1;
  },

  async getLetter(letterId: string): Promise<LetterRecord | null> {
    const result = await database().query<LetterRecord>(
      `SELECT id, manager_name, company, last_day::text, reason, tone, payment_mode,
              payment_status, stripe_session_id, letter_text
       FROM public.resignation_letters WHERE id = $1`,
      [letterId],
    );
    return result.rows[0] ?? null;
  },

  async recordPaid(letterId: string, sessionId: string, mode: StripeMode, paymentIntentId: string | null) {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET payment_status = 'paid', stripe_payment_intent_id = COALESCE($4, stripe_payment_intent_id),
           updated_at = now()
       WHERE id = $1 AND stripe_session_id = $2 AND payment_mode = $3`,
      [letterId, sessionId, mode, paymentIntentId],
    );
    return result.rowCount === 1;
  },

  async applyWebhookStatus(
    letterId: string,
    mode: StripeMode,
    status: 'paid' | 'failed' | 'expired',
    sessionId: string | null,
    paymentIntentId: string | null,
  ) {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET payment_status = CASE WHEN payment_status = 'paid' THEN 'paid' ELSE $3 END,
           stripe_session_id = COALESCE(stripe_session_id, $4),
           stripe_payment_intent_id = COALESCE($5, stripe_payment_intent_id),
           updated_at = now()
       WHERE id = $1 AND payment_mode = $2
         AND (payment_status = 'pending' OR payment_status = $3 OR $3 = 'paid')
         AND ($4::text IS NULL OR stripe_session_id IS NULL OR stripe_session_id = $4)`,
      [letterId, mode, status, sessionId, paymentIntentId],
    );
    return result.rowCount === 1;
  },

  async saveLetterText(letterId: string, letterText: string): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET letter_text = $2, updated_at = now()
       WHERE id = $1 AND payment_status = 'paid' AND letter_text IS NULL`,
      [letterId, letterText],
    );
    return result.rowCount === 1;
  },
};