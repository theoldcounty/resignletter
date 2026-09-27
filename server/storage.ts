import { Pool } from 'pg';
import type { LetterInput, StripeMode } from './payment';

export type LetterRecord = {
  id: string;
  sender_name: string | null;
  manager_name: string;
  company: string;
  home_address: string | null;
  office_address: string | null;
  last_day: string;
  reason: string | null;
  tone: LetterInput['tone'];
  payment_mode: StripeMode;
  payment_status: string;
  stripe_session_id: string | null;
  stripe_price_id: string | null;
  stripe_payment_intent_id: string | null;
  letter_text: string | null;
  letter_generated_at: string | null;
  return_seen_at: string | null;
};

let pool: Pool | undefined;

function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('Database is not configured.');
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export const storage = {
  async createPendingLetter(form: LetterInput, mode: StripeMode, gaClientId?: string, priceId?: string): Promise<string> {
    const result = await database().query<{ id: string }>(
      `INSERT INTO public.resignation_letters
        (sender_name, manager_name, company, home_address, office_address,
         last_day, reason, tone, payment_mode, payment_status, ga_client_id, stripe_price_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)
       RETURNING id`,
      [form.senderName, form.managerName, form.company, form.homeAddress, form.officeAddress,
        form.lastDay, form.reason, form.tone, mode, gaClientId ?? null, priceId ?? null],
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
      `SELECT id, sender_name, manager_name, company, home_address, office_address,
               last_day::text, reason, tone, payment_mode, payment_status,
               stripe_session_id, stripe_price_id, stripe_payment_intent_id, letter_text,
               to_char(return_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS return_seen_at,
               to_char(letter_generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS letter_generated_at
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
        WHERE id = $1 AND stripe_session_id = $2 AND payment_mode = $3
          AND payment_status IN ('pending', 'paid')`,
      [letterId, sessionId, mode, paymentIntentId],
    );
    return result.rowCount === 1;
  },

  async markReturnSeen(letterId: string, sessionId: string, mode: StripeMode): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET return_seen_at = COALESCE(return_seen_at, now())
       WHERE id = $1 AND stripe_session_id = $2 AND payment_mode = $3
         AND payment_status = 'paid'`,
      [letterId, sessionId, mode],
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
          AND (payment_status = 'pending' OR payment_status = $3
               OR ($3 = 'paid' AND payment_status NOT IN ('refund_pending', 'refunded')))
         AND ($4::text IS NULL OR stripe_session_id IS NULL OR stripe_session_id = $4)`,
      [letterId, mode, status, sessionId, paymentIntentId],
    );
    return result.rowCount === 1;
  },

  async saveLetterText(letterId: string, letterText: string): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET letter_text = $2, letter_generated_at = now(), updated_at = now()
       WHERE id = $1 AND payment_status = 'paid' AND letter_text IS NULL`,
      [letterId, letterText],
    );
    return result.rowCount === 1;
  },

  async claimRefund(letterId: string, sessionId: string, mode: StripeMode, requireUnreturned = false): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET payment_status = 'refund_pending', updated_at = now()
       WHERE id = $1 AND stripe_session_id = $2 AND payment_mode = $3
          AND payment_status IN ('paid', 'refund_pending') AND letter_text IS NULL
          AND ($4::boolean = false OR return_seen_at IS NULL)`,
      [letterId, sessionId, mode, requireUnreturned],
    );
    return result.rowCount === 1;
  },

  async markRefunded(letterId: string, sessionId: string, mode: StripeMode): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET payment_status = 'refunded', updated_at = now()
       WHERE id = $1 AND stripe_session_id = $2 AND payment_mode = $3
         AND payment_status = 'refund_pending' AND letter_text IS NULL`,
      [letterId, sessionId, mode],
    );
    return result.rowCount === 1;
  },

  async claimOutstanding(limit = 5): Promise<Array<{
    id: string; stripe_session_id: string; payment_mode: StripeMode;
    created_at: string; return_seen_at: string | null;
  }>> {
    const result = await database().query<{
      id: string; stripe_session_id: string; payment_mode: StripeMode;
      created_at: string; return_seen_at: string | null;
    }>(
      `WITH due AS (
         SELECT id FROM public.resignation_letters
         WHERE stripe_session_id IS NOT NULL AND letter_text IS NULL
           AND payment_status IN ('pending', 'paid', 'refund_pending')
           AND (fulfillment_checked_at IS NULL OR fulfillment_checked_at < now() - interval '2 minutes')
           AND (payment_status <> 'pending' OR updated_at < now() - interval '30 seconds')
         ORDER BY COALESCE(fulfillment_checked_at, created_at)
         LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE public.resignation_letters AS r
       SET fulfillment_checked_at = now()
       FROM due WHERE r.id = due.id
       RETURNING r.id, r.stripe_session_id, r.payment_mode,
         to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
         to_char(r.return_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS return_seen_at`,
      [limit],
    );
    return result.rows;
  },
};