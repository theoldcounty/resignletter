/**
 * Historical Supabase/Deno endpoint for saving resignation details, creating a
 * Stripe Checkout Session, and confirming a browser return. The active app is
 * started by Express (server/index.ts); no active Express route imports this
 * function. This file's presence does not mean the Supabase function is deployed.
 *
 * Supabase JWT verification is disabled for this endpoint, so request data is
 * treated as untrusted. Payment confirmation comes from Stripe's retrieved
 * session, and privileged Supabase writes happen only on the server.
 * Deno.serve supplies the Edge runtime; Stripe's SDK handles provider API calls,
 * while supabase-js persists the pending letter and verified payment state.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import Stripe from "npm:stripe@17.7.0";
import { parseLetterInput } from "../_shared/letter.ts";
import {
  checkoutSessionParams,
  configuredAppOrigin,
  configuredCheckoutMode,
  isStripeMode,
  isVerifiedCheckoutSession,
  stripeKeyForMode,
} from "../_shared/payment.ts";

// These headers allow browser preflight and JSON requests; CORS is not an
// authentication mechanism, so the handler still validates every request.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

/** Keep all endpoint responses JSON-shaped and attach the browser CORS policy. */
function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * The old endpoint combines two actions: create a hosted checkout, or verify
 * that Stripe completed one after the browser returns. The latter trusts
 * Stripe's API response, never a query-string success flag.
 */
Deno.serve(async (req: Request) => {
  // Browser preflight is separate from the actual payment request.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    // `action` selects one of the two supported operations; all other body
    // fields remain untrusted until narrowed by the relevant branch.
    const body = await req.json();
    const action = body.action ?? "create-checkout";
    const { letterId, mode, sessionId } = body;

    // Validate mode before choosing credentials or comparing checkout state.
    if (!isStripeMode(mode)) {
      return jsonResponse({ error: "Invalid payment environment." }, 400);
    }

    if (action === "create-checkout") {
      // Checkout creation must match the server-selected environment so a
      // browser cannot switch a live deployment to test (or vice versa).
      const configuredMode = configuredCheckoutMode(Deno.env.get("PAYMENT_MODE"));
      if (!configuredMode) {
        return jsonResponse({ error: "The checkout payment environment is not configured correctly." }, 503);
      }
      if (mode !== configuredMode) {
        return jsonResponse({ error: "Checkout is not available in this payment environment." }, 409);
      }
    }

    // The shared helper selects the mode-specific secret and rejects mismatched
    // Stripe key prefixes before the SDK can make an API request.
    const stripeKey = stripeKeyForMode(mode, (name) => Deno.env.get(name));
    if (!stripeKey.ok) return jsonResponse({ error: stripeKey.error }, 503);

    // Pinning Stripe's API version keeps this older endpoint's request/response
    // contract stable as the provider evolves.
    const stripe = new Stripe(stripeKey.key, {
      apiVersion: "2025-08-27.basil",
    });

    if (action === "verify-payment") {
      // IDs only identify the session/letter; they do not prove payment.
      if (typeof letterId !== "string" || !letterId.trim() ||
        typeof sessionId !== "string" || !sessionId.trim()) {
        return jsonResponse({ error: "A letter and checkout session are required." }, 400);
      }

      // Retrieve the session directly from Stripe, then bind its metadata,
      // paid state, and test/live flag to this request before touching storage.
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (!isVerifiedCheckoutSession(session, letterId, mode)) {
        return jsonResponse({ verified: false, error: "Stripe could not confirm this payment." }, 402);
      }

      // The service-role key bypasses row-level security. Keep it server-only
      // and use it only after Stripe has independently confirmed the payment.
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!supabaseUrl || !serviceRoleKey) {
        return jsonResponse({ error: "Payment confirmation storage is not configured." }, 503);
      }
      const supabase = createClient(supabaseUrl, serviceRoleKey);
      // Stripe may return the PaymentIntent as an ID or as an expanded object.
      const paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
      // Record the authoritative result so the older generator can require the
      // same paid flag before disclosing or creating a letter.
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

    // Validate the configured HTTPS origin rather than constructing redirect
    // URLs from a caller-controlled Host or return URL.
    const origin = configuredAppOrigin(Deno.env.get("APP_BASE_URL"));
    if (!origin) return jsonResponse({ error: "The app return URL is not configured." }, 503);
    // Convert arbitrary JSON to bounded, normalized form data before storage.
    const form = parseLetterInput(body.form);
    if (!form) return jsonResponse({ error: "Please check the letter details and try again." }, 400);

    // Save the pending row first so its database ID can be attached to the
    // Stripe session and used to correlate the eventual payment notification.
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

    // Preserve only the expected GA client-ID shape; arbitrary request text
    // must not be forwarded as an analytics identifier.
    const gaClientId = typeof body.gaClientId === "string" &&
      /^[0-9]+\.[0-9]+$/.test(body.gaClientId) &&
      body.gaClientId.length <= 100
      ? body.gaClientId
      : undefined;
    // Shared params keep the return URLs and metadata consistent with the
    // verification and webhook handlers.
    const session = await stripe.checkout.sessions.create(
      checkoutSessionParams(origin, record.id, mode, gaClientId),
    );
    if (!session.url) return jsonResponse({ error: "Stripe did not provide a checkout link." }, 502);

    return jsonResponse({ url: session.url, mode });
  } catch {
    // Do not expose Stripe/Supabase exception details to a public caller.
    return jsonResponse({ error: "Payment setup failed. Please try again." }, 500);
  }
});