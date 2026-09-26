import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import Stripe from "npm:stripe@17.7.0";
import { isStripeMode, isVerifiedCheckoutSession, stripeKeyForMode } from "../_shared/payment.ts";

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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const { letterId, sessionId, mode } = await req.json();
    if (!isStripeMode(mode) || typeof letterId !== "string" || !letterId.trim() ||
      typeof sessionId !== "string" || !sessionId.trim()) {
      return jsonResponse({ error: "A valid paid checkout is required." }, 400);
    }

    const stripeKey = stripeKeyForMode(mode, (name) => Deno.env.get(name));
    if (!stripeKey.ok) return jsonResponse({ error: stripeKey.error }, 503);
    const stripe = new Stripe(stripeKey.key, { apiVersion: "2025-08-27.basil" });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isVerifiedCheckoutSession(session, letterId, mode)) {
      return jsonResponse({ error: "Payment could not be verified." }, 402);
    }

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
    if (lookupError) return jsonResponse({ error: "Could not retrieve the letter." }, 500);
    if (!record) return jsonResponse({ error: "Letter not found." }, 404);
    if (!record.paid) return jsonResponse({ error: "Payment has not been recorded yet. Please retry." }, 409);
    if (record.letter_text) return jsonResponse({ letter: record.letter_text });

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) return jsonResponse({ error: "AI service is not configured." }, 503);

    const systemPrompt = `You are an HR advisor. Write a professional resignation letter. Include: formal greeting, clear statement of resignation, last working day, brief thanks, offer to help transition. Keep it under 250 words. Tone should match the user's choice. Return ONLY valid JSON: {"letter": "full text here"}`;
    const userContent = `Manager: ${record.manager_name}\nCompany: ${record.company}\nLast Day: ${record.last_day}\nReason: ${record.reason || "Not provided"}\nTone: ${record.tone}`;

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

    const aiData = await aiResponse.json();
    const letterText = JSON.parse(aiData.choices?.[0]?.message?.content ?? "{}").letter;
    if (typeof letterText !== "string" || !letterText.trim()) {
      return jsonResponse({ error: "Letter generation returned no content. Please retry." }, 502);
    }

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
    return jsonResponse({ error: "Could not prepare your letter. Please retry." }, 500);
  }
});