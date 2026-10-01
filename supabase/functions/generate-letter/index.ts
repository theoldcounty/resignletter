/**
 * Historical Supabase/Deno letter-generation endpoint. The active app starts
 * through Express (server/index.ts) and does not import this function; its
 * presence is not evidence that the Supabase function is deployed.
 *
 * The old flow retrieves checkout state from Stripe, checks the stored paid
 * flag, asks OpenAI for structured JSON, then caches the result in Supabase.
 * These checks matter because Supabase JWT verification is disabled here.
 * Deno.serve hosts the handler; Stripe, the OpenAI HTTP API, and supabase-js
 * each provide a distinct server-side boundary in that sequence.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import Stripe from "npm:stripe@17.7.0";
import { isStripeMode, isVerifiedCheckoutSession, stripeKeyForMode } from "../_shared/payment.ts";

// Browser CORS headers permit the old frontend to call the function directly;
// they do not authenticate the caller or replace the checks below.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

/** Return JSON consistently so callers can handle errors without parsing HTML. */
function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Generate a letter only for a Stripe-confirmed, already-paid record. The
 * stored text is reused on later requests to avoid repeated AI calls and
 * to return the same result after a retry.
 */
Deno.serve(async (req: Request) => {
  // Handle the old browser's preflight separately; all data requests are POST.
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    // Identifiers and mode arrive from the caller, so validate their shape
    // before using them to select credentials or look up a record.
    const { letterId, sessionId, mode } = await req.json();
    if (!isStripeMode(mode) || typeof letterId !== "string" || !letterId.trim() ||
      typeof sessionId !== "string" || !sessionId.trim()) {
      return jsonResponse({ error: "A valid paid checkout is required." }, 400);
    }

    // Verify the checkout with Stripe's server API. A return URL/session ID
    // supplied by the browser is not itself proof of payment.
    const stripeKey = stripeKeyForMode(mode, (name) => Deno.env.get(name));
    if (!stripeKey.ok) return jsonResponse({ error: stripeKey.error }, 503);
    const stripe = new Stripe(stripeKey.key, { apiVersion: "2025-08-27.basil" });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isVerifiedCheckoutSession(session, letterId, mode)) {
      return jsonResponse({ error: "Payment could not be verified." }, 402);
    }

    // The service-role key bypasses RLS. It remains server-side and is used
    // only after payment has been verified with Stripe.
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Letter storage is not configured." }, 503);
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: record, error: lookupError } = await supabase
      .from("resignation_letters")
      .select("id, manager_name, company, last_day, reason, tone, paid, letter_text")
      .eq("id", letterId)
      .maybeSingle();
    // Separate database failures from an unknown identifier without exposing
    // Supabase's internal error details to the caller.
    if (lookupError) return jsonResponse({ error: "Could not retrieve the letter." }, 500);
    if (!record) return jsonResponse({ error: "Letter not found." }, 404);
    // Stripe confirms the charge, while this database flag confirms the
    // webhook/checkout flow recorded it for this letter before generation.
    if (!record.paid) return jsonResponse({ error: "Payment has not been recorded yet. Please retry." }, 409);
    // Returning the saved text makes retries idempotent and avoids another AI
    // request (and additional cost) after a successful first generation.
    if (record.letter_text) return jsonResponse({ letter: record.letter_text });

    // Keep the provider key on the server; it is never sent to the browser.
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) return jsonResponse({ error: "AI service is not configured." }, 503);

    // The system prompt sets output requirements; the user content contains
    // only the saved form fields needed to draft this letter.
    const systemPrompt = `You are an HR advisor. Write a professional resignation letter. Include: formal greeting, clear statement of resignation, last working day, brief thanks, offer to help transition. Keep it under 250 words. Tone should match the user's choice. Return ONLY valid JSON: {"letter": "full text here"}`;
    const userContent = `Manager: ${record.manager_name}\nCompany: ${record.company}\nLast Day: ${record.last_day}\nReason: ${record.reason || "Not provided"}\nTone: ${record.tone}`;

    // Call the OpenAI Chat Completions API with JSON-mode output so the response
    // can be parsed predictably rather than scraping prose.
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!aiResponse.ok) return jsonResponse({ error: "Letter generation failed. Please retry." }, 502);

    // Unwrap the API envelope and validate its generated field before storage.
    const aiData = await aiResponse.json();
    const letterText = JSON.parse(aiData.choices?.[0]?.message?.content ?? "{}").letter;
    if (typeof letterText !== "string" || !letterText.trim()) {
      return jsonResponse({ error: "Letter generation returned no content. Please retry." }, 502);
    }

    // The additional `paid` predicate protects the write if payment state
    // changed while the external AI request was in flight.
    const { data: saved, error: saveError } = await supabase
      .from("resignation_letters")
      .update({ letter_text: letterText })
      .eq("id", letterId)
      .eq("paid", true)
      .select("id")
      .maybeSingle();
    if (saveError || !saved) return jsonResponse({ error: "Could not save your letter. Please retry." }, 500);

    return jsonResponse({ letter: letterText });
  } catch {
    // Keep provider, parsing, and database exception details out of public
    // responses; the caller receives a retryable generic error instead.
    return jsonResponse({ error: "Could not prepare your letter. Please retry." }, 500);
  }
});