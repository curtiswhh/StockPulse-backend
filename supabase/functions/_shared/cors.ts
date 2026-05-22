// _shared/cors.ts
// CORS preflight + headers for Supabase Edge Functions.
//
// Allows the iOS app's URLSession to call these endpoints. iOS doesn't
// strictly enforce CORS the way browsers do, but the Supabase function
// runtime does inject Origin checks, and the Supabase dashboard's
// "Invoke Function" tester is browser-based — without these headers,
// you can't smoke-test from the dashboard.
//
// Locked to all origins (`*`) because the iOS app is the only caller and
// has no fixed Origin header. Tighten if you ever expose these endpoints
// to a web client.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/// Returns a 204 response for OPTIONS preflight. Call at the top of every
/// function: `if (req.method === "OPTIONS") return preflight();`
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/// Wrap a JSON payload with the standard headers. Status defaults to 200.
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/// Standard error shape. Keeps iOS-side decoding simple — every error has
/// `{ error: string }` regardless of which code path failed.
export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}
