import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import Stripe from "npm:stripe@17.7.0";
import {
  isStripeMode,
  isVerifiedCheckoutSession,
  stripePriceIds,
  stripeProductIds,
} from "../_shared/payment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const action = body.action ?? "create-checkout";
    const { letterId, mode, sessionId } = body;

    if (!isStripeMode(mode)) {
      return jsonResponse({ error: "Choose test or live payment mode." }, 400);
    }
    if (typeof letterId !== "string" || !letterId.trim()) {
      return jsonResponse({ error: "A letter ID is required." }, 400);
    }

    const stripeKeyName = mode === "test" ? "STRIPE_TEST_SECRET_KEY" : "STRIPE_LIVE_SECRET_KEY";
    const stripeKey = Deno.env.get(stripeKeyName);
    if (!stripeKey) {
      return jsonResponse({ error: `${mode === "test" ? "Test" : "Live"} Stripe mode is not configured.` }, 503);
    }
    const expectedKeyPrefix = mode === "test" ? "sk_test_" : "sk_live_";
    if (!stripeKey.startsWith(expectedKeyPrefix)) {
      return jsonResponse({ error: `The ${mode} Stripe key does not match its selected mode.` }, 503);
    }

    const stripe = new Stripe(stripeKey, {
      apiVersion: "2025-08-27.basil",
    });

    if (action === "verify-payment") {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        return jsonResponse({ error: "A checkout session ID is required." }, 400);
      }

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (!isVerifiedCheckoutSession(session, letterId, mode)) {
        return jsonResponse({ verified: false, error: "Stripe could not confirm this payment." }, 402);
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!supabaseUrl || !serviceRoleKey) {
        return jsonResponse({ error: "Payment confirmation storage is not configured." }, 503);
      }

      const supabase = createClient(supabaseUrl, serviceRoleKey);
      const paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
      const { data, error } = await supabase
        .from("resignation_letters")
        .update({
          paid: true,
          payment_intent_id: paymentIntentId,
          payment_status: "paid",
        })
        .eq("id", letterId)
        .select("id")
        .maybeSingle();

      if (error) throw error;
      if (!data) return jsonResponse({ error: "Letter record not found." }, 404);
      return jsonResponse({ verified: true, mode });
    }

    if (action !== "create-checkout") {
      return jsonResponse({ error: "Unsupported payment action." }, 400);
    }

    const requestOrigin = req.headers.get("origin") || Deno.env.get("APP_BASE_URL");
    if (!requestOrigin) {
      return jsonResponse({ error: "The app return URL is not configured." }, 400);
    }
    const origin = new URL(requestOrigin).origin;
    const gaClientId = typeof body.gaClientId === "string" &&
      /^[0-9]+\.[0-9]+$/.test(body.gaClientId) &&
      body.gaClientId.length <= 100
      ? body.gaClientId
      : undefined;
    const metadata: Record<string, string> = {
      letter_id: letterId,
      stripe_mode: mode,
      stripe_product_id: stripeProductIds[mode],
      stripe_price_id: stripePriceIds[mode],
    };
    if (gaClientId) metadata.ga_client_id = gaClientId;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: stripePriceIds[mode], quantity: 1 }],
      metadata,
      payment_intent_data: { metadata },
      success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&letter_id=${encodeURIComponent(letterId)}&mode=${mode}`,
      cancel_url: `${origin}/?cancelled=true&mode=${mode}`,
    });

    return jsonResponse({ url: session.url, sessionId: session.id, mode });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Unexpected payment error." },
      500,
    );
  }
});