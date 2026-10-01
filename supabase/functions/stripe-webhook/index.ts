/**
 * Historical Supabase/Deno Stripe webhook. The current app is served by
 * Express (server/index.ts) and does not import this function; this file does
 * not establish that a webhook endpoint is deployed.
 *
 * Supabase JWT verification is disabled for webhooks, so the raw Stripe
 * signature is the trust boundary. Only after verifying it does this handler
 * update the old Supabase payment record or send optional GA4 analytics.
 * Deno.serve hosts the endpoint, Web Crypto checks Stripe's HMAC, and
 * supabase-js writes payment state; GA4 is a best-effort follow-on request.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  isStripeMode,
  paymentAnalyticsParams,
  paymentStatusForStripeEvent,
  verifyStripeSignature,
} from "../_shared/payment.ts";

// Measurement Protocol events are sent server-to-server so payment details
// can be attributed without trusting a browser-side purchase callback.
const GA_MEASUREMENT_ID = "G-HF4121ZYTH";

/** Shape the webhook's JSON responses consistently for Stripe delivery retries. */
function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Translate signed Stripe events into payment state. Acknowledge unrelated
 * events without processing them so Stripe does not retry work this endpoint
 * intentionally ignores.
 */
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // The signature header authenticates the sender only when checked against the
  // exact raw payload; parsing or re-serializing it first would break HMAC checks.
  const signature = req.headers.get("stripe-signature");
  if (!signature) return jsonResponse({ error: "Missing Stripe signature." }, 400);

  let event: {
    id?: string;
    type?: string;
    livemode?: boolean;
    data?: { object?: Record<string, unknown> };
  };
  const rawBody = await req.text();
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid event payload." }, 400);
  }

  // Require enough signed envelope data to select a secret and interpret the
  // event; an incomplete object cannot safely drive a database update.
  if (typeof event.livemode !== "boolean" || !event.type || !event.data?.object) {
    return jsonResponse({ error: "Incomplete Stripe event." }, 400);
  }

  // Stripe's signed livemode flag chooses which webhook secret is required.
  const mode = event.livemode ? "live" : "test";
  if (!isStripeMode(mode)) return jsonResponse({ error: "Unsupported Stripe mode." }, 400);

  // Keep test and live webhook secrets isolated just like the checkout API keys.
  const secretName = mode === "test" ? "STRIPE_TEST_WEBHOOK_SECRET" : "STRIPE_LIVE_WEBHOOK_SECRET";
  const webhookSecret = Deno.env.get(secretName);
  if (!webhookSecret) return jsonResponse({ error: `${mode} webhook is not configured.` }, 503);

  // Reject unsigned or stale requests before trusting event type, metadata, or IDs.
  const signatureValid = await verifyStripeSignature(rawBody, signature, webhookSecret);
  if (!signatureValid) return jsonResponse({ error: "Invalid Stripe signature." }, 400);

  // Map only supported payment outcomes; other valid Stripe notifications are
  // acknowledged without opening the database or sending analytics.
  const stripeObject = event.data.object;
  const paymentStatus = paymentStatusForStripeEvent(
    event.type,
    typeof stripeObject.payment_status === "string" ? stripeObject.payment_status : undefined,
  );
  if (!paymentStatus) return jsonResponse({ received: true, processed: false });

  // Checkout metadata links this signed payment back to its letter and mode.
  const metadata = stripeObject.metadata as Record<string, string | undefined> | undefined;
  const letterId = metadata?.letter_id;
  if (!letterId || metadata?.stripe_mode !== mode) {
    return jsonResponse({ received: true, processed: false });
  }

  // The service role bypasses RLS, so keep it server-side and reach this write
  // only after validating the Stripe signature and metadata above.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Payment status storage is not configured." }, 503);
  }

  // Checkout events carry a PaymentIntent reference; payment_intent events use
  // their own object ID. Normalize both shapes for the same database column.
  const paymentIntent = stripeObject.payment_intent;
  const paymentIntentId = event.type.startsWith("payment_intent.")
    ? String(stripeObject.id)
    : typeof paymentIntent === "string"
      ? paymentIntent
      : paymentIntent && typeof paymentIntent === "object" && "id" in paymentIntent
        ? String(paymentIntent.id)
        : null;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  let paymentUpdate = supabase
    .from("resignation_letters")
    .update({
      paid: paymentStatus === "paid",
      payment_status: paymentStatus,
      payment_intent_id: paymentIntentId,
    })
    .eq("id", letterId);
  // Failure/expiry events must not overwrite a record that has already become
  // paid; paid events remain repeatable so webhook retries are safe.
  if (paymentStatus !== "paid") paymentUpdate = paymentUpdate.eq("paid", false);

  const { data, error } = await paymentUpdate
    .select("id")
    .maybeSingle();

  if (error) return jsonResponse({ error: "Could not store payment status." }, 500);
  if (!data) {
    // A conditional update can match zero rows when a retry or out-of-order
    // event arrives. Distinguish an unknown letter from a paid record that
    // correctly ignored a later failure/expiry notification.
    const { data: currentRecord, error: lookupError } = await supabase
      .from("resignation_letters")
      .select("id, paid")
      .eq("id", letterId)
      .maybeSingle();
    if (lookupError) return jsonResponse({ error: "Could not check payment status." }, 500);
    if (!currentRecord) return jsonResponse({ error: "Letter record not found." }, 404);
    if (currentRecord.paid && paymentStatus !== "paid") {
      return jsonResponse({ received: true, processed: false, status: "paid" });
    }
    return jsonResponse({ error: "Payment status update did not apply." }, 500);
  }

  // Analytics is optional and downstream of the successful database update;
  // a GA outage must not make Stripe retry or undo a recorded payment.
  const gaApiSecret = Deno.env.get("GA4_API_SECRET");
  const gaClientId = metadata.ga_client_id;
  const gaEventName = paymentStatus === "paid"
    ? "purchase"
    : paymentStatus === "failed"
      ? "payment_failed"
      : paymentStatus === "expired"
        ? "checkout_expired"
        : null;
  let analyticsSent = false;

  // Send only when both the server credential and a previously validated
  // checkout client ID exist. Do not block payment fulfillment on this request.
  if (gaApiSecret && gaClientId && gaEventName) {
    try {
      const analyticsResponse = await fetch(
        `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${encodeURIComponent(gaApiSecret)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: gaClientId,
            events: [{
              name: gaEventName,
              params: paymentAnalyticsParams(
                paymentStatus,
                mode,
                metadata.stripe_product_id,
                typeof stripeObject.amount_total === "number"
                  ? stripeObject.amount_total
                  : typeof stripeObject.amount === "number"
                    ? stripeObject.amount
                    : undefined,
                typeof stripeObject.currency === "string" ? stripeObject.currency : undefined,
              ),
            }],
          }),
        },
      );
      analyticsSent = analyticsResponse.ok;
      if (!analyticsResponse.ok) {
        console.error("Google Analytics Measurement Protocol rejected a payment event.");
      }
    } catch {
      console.error("Google Analytics Measurement Protocol request failed.");
    }
  }

  return jsonResponse({ received: true, processed: true, status: paymentStatus, analyticsSent });
});