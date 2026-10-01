/**
 * PostgreSQL adapter for letter and payment state.
 * Express calls this boundary rather than writing SQL in routes; parameterized
 * queries protect user values, while conditional updates make retries and
 * competing webhook/customer requests safe without a process-local lock.
 */
import { Pool } from 'pg';
import type { LetterInput, StripeMode } from './payment';

/**
 * Application view of one resignation_letters row. Timestamps are selected as
 * UTC strings for the API, while Stripe IDs link our record to provider state.
 */
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

// One lazily opened pool per Node process; keeping it shared avoids opening a
// fresh PostgreSQL connection for every route call.
let pool: Pool | undefined;

/** Create the shared PostgreSQL pool on first use and fail clearly if unconfigured. */
function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('Database is not configured.');
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export const storage = {
  /**
   * Persist validated form data before Checkout exists. The generated UUID is
   * the stable correlation ID later written into Stripe metadata and webhooks.
   */
  async createPendingLetter(form: LetterInput, mode: StripeMode, gaClientId?: string, priceId?: string): Promise<string> {
    // Use positional parameters rather than string interpolation so names,
    // addresses, and other user-controlled fields remain data, not SQL.
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

  /**
   * Attach Stripe's Checkout session only while the order is still pending.
   * The conditional update guards against overwriting state changed meanwhile.
   */
  async setCheckoutSession(letterId: string, sessionId: string): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET stripe_session_id = $2, updated_at = now()
       WHERE id = $1 AND payment_status = 'pending'`,
      [letterId, sessionId],
    );
    return result.rowCount === 1;
  },

  /** Load one order and serialize timestamps consistently for API responses. */
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

  /**
   * Record payment only for the matching order/session/mode. Allow an identical
   * paid retry, but do not transition failed, expired, or refunded orders back.
   */
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

  /**
   * Record that the customer reached the app after Checkout. Reconciliation
   * requires this marker so an abandoned session alone does not trigger work.
   */
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

  /**
   * Apply a verified Stripe event to the matching row in one atomic update.
   * Keep paid state monotonic against stale failure events and protect refund
   * states from late success events; session matching prevents cross-order writes.
   */
  async applyWebhookStatus(
    letterId: string,
    mode: StripeMode,
    status: 'paid' | 'failed' | 'expired',
    sessionId: string | null,
    paymentIntentId: string | null,
  ) {
    // COALESCE fills provider IDs when an event supplies them without erasing
    // values already learned from Checkout or an earlier webhook.
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

  /**
   * Save generated text exactly once and only while payment remains paid.
   * The predicate is the concurrency guard when two fulfillment requests race.
   */
  async saveLetterText(letterId: string, letterText: string): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET letter_text = $2, letter_generated_at = now(), updated_at = now()
       WHERE id = $1 AND payment_status = 'paid' AND letter_text IS NULL`,
      [letterId, letterText],
    );
    return result.rowCount === 1;
  },

  /**
   * Atomically claim or resume refund handling for a paid order with no saved letter.
   * Returning rowCount lets callers distinguish a valid claim from a stale or
   * conflicting state without risking a refund for another session.
   */
  async claimRefund(letterId: string, sessionId: string, mode: StripeMode): Promise<boolean> {
    const result = await database().query(
      `UPDATE public.resignation_letters
       SET payment_status = 'refund_pending', updated_at = now()
       WHERE id = $1 AND stripe_session_id = $2 AND payment_mode = $3
           AND payment_status IN ('paid', 'refund_pending') AND letter_text IS NULL`,
      [letterId, sessionId, mode],
    );
    return result.rowCount === 1;
  },

  /** Store Stripe-confirmed refund completion, never an unverified request. */
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

  /**
   * Claim a small batch of orders eligible for recovery after customer return.
   * PostgreSQL locks and SKIP LOCKED coordinate multiple app instances, while
   * the timestamp throttles repeated provider calls after transient failures.
   */
  async claimOutstanding(limit = 5): Promise<Array<{
    id: string; stripe_session_id: string; payment_mode: StripeMode;
    return_seen_at: string | null;
  }>> {
    // The CTE selects and marks each due order in one statement, avoiding a
    // race between finding work and claiming it for this reconciliation pass.
    const result = await database().query<{
      id: string; stripe_session_id: string; payment_mode: StripeMode;
      return_seen_at: string | null;
    }>(
      `WITH due AS (
         SELECT id FROM public.resignation_letters
         WHERE stripe_session_id IS NOT NULL AND return_seen_at IS NOT NULL
           AND letter_text IS NULL AND payment_status IN ('paid', 'refund_pending')
           AND (fulfillment_checked_at IS NULL OR fulfillment_checked_at < now() - interval '2 minutes')
         ORDER BY COALESCE(fulfillment_checked_at, created_at)
         LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE public.resignation_letters AS r
       SET fulfillment_checked_at = now()
       FROM due WHERE r.id = due.id
        RETURNING r.id, r.stripe_session_id, r.payment_mode,
         to_char(r.return_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS return_seen_at`,
      [limit],
    );
    return result.rows;
  },
};