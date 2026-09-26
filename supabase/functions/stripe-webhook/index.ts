import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  isStripeMode,
  paymentStatusForStripeEvent,
  verifyStripeSignature,
} from "../_shared/payment.ts";

const GA_MEASUREMENT_ID = "G-HF4121ZYTH";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

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

  if (typeof event.livemode !== "boolean" || !event.type || !event.data?.object) {
    return jsonResponse({ error: "Incomplete Stripe event." }, 400);
  }

  const mode = event.livemode ? "live" : "test";
  if (!isStripeMode(mode)) return jsonResponse({ error: "Unsupported Stripe mode." }, 400);

  const secretName = mode === "test" ? "STRIPE_TEST_WEBHOOK_SECRET" : "STRIPE_LIVE_WEBHOOK_SECRET";
  const webhookSecret = Deno.env.get(secretName);
  if (!webhookSecret) return jsonResponse({ error: `${mode} webhook is not configured.` }, 503);

  const signatureValid = await verifyStripeSignature(rawBody, signature, webhookSecret);
  if (!signatureValid) return jsonResponse({ error: "Invalid Stripe signature." }, 400);

  const stripeObject = event.data.object;
  const paymentStatus = paymentStatusForStripeEvent(
    event.type,
    typeof stripeObject.payment_status === "string" ? stripeObject.payment_status : undefined,
  );
  if (!paymentStatus) return jsonResponse({ received: true, processed: false });

  const metadata = stripeObject.metadata as Record<string, string | undefined> | undefined;
  const letterId = metadata?.letter_id;
  if (!letterId || metadata?.stripe_mode !== mode) {
    return jsonResponse({ received: true, processed: false });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Payment status storage is not configured." }, 503);
  }

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
  if (paymentStatus !== "paid") paymentUpdate = paymentUpdate.eq("paid", false);

  const { data, error } = await paymentUpdate
    .select("id")
    .maybeSingle();

  if (error) return jsonResponse({ error: "Could not store payment status." }, 500);
  if (!data) {
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
              params: {
                transaction_id: String(stripeObject.id ?? event.id ?? ""),
                payment_mode: mode,
                payment_status: paymentStatus,
                item_id: metadata.stripe_product_id ?? "",
                currency: "GBP",
              },
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