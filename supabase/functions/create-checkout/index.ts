import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import Stripe from "npm:stripe@17.7.0";
import { parseLetterInput } from "../_shared/letter.ts";
import {
  checkoutSessionParams,
  configuredAppOrigin,
  isStripeMode,
  isVerifiedCheckoutSession,
  stripeKeyForMode,
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

    const stripeKey = stripeKeyForMode(mode, (name) => Deno.env.get(name));
    if (!stripeKey.ok) return jsonResponse({ error: stripeKey.error }, 503);

    const stripe = new Stripe(stripeKey.key, {
      apiVersion: "2025-08-27.basil",
    });

    if (action === "verify-payment") {
      if (typeof letterId !== "string" || !letterId.trim() ||
        typeof sessionId !== "string" || !sessionId.trim()) {
        return jsonResponse({ error: "A letter and checkout session are required." }, 400);
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

    const origin = configuredAppOrigin(Deno.env.get("APP_BASE_URL"));
    if (!origin) return jsonResponse({ error: "The app return URL is not configured." }, 503);
    const form = parseLetterInput(body.form);
    if (!form) return jsonResponse({ error: "Please check the letter details and try again." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Letter storage is not configured." }, 503);
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: record, error: insertError } = await supabase
      .from("resignation_letters")
      .insert({
        manager_name: form.managerName,
        company: form.company,
        last_day: form.lastDay,
        reason: form.reason,
        tone: form.tone,
        paid: false,
        payment_status: "pending",
      })
      .select("id")
      .single();
    if (insertError || !record) {
      return jsonResponse({ error: "Could not save your details. Please try again." }, 500);
    }

    const gaClientId = typeof body.gaClientId === "string" &&
      /^[0-9]+\.[0-9]+$/.test(body.gaClientId) &&
      body.gaClientId.length <= 100
      ? body.gaClientId
      : undefined;
    const session = await stripe.checkout.sessions.create(
      checkoutSessionParams(origin, record.id, mode, gaClientId),
    );
    if (!session.url) return jsonResponse({ error: "Stripe did not provide a checkout link." }, 502);

    return jsonResponse({ url: session.url, mode });
  } catch {
    return jsonResponse({ error: "Payment setup failed. Please try again." }, 500);
  }
});