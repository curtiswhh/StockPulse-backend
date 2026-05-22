// _shared/supabase_admin.ts
// Service-role Supabase client for Edge Functions.
//
// Why service-role: this client reads `stock_price` (already public) AND
// reads/writes `quote_cache` (RLS-locked). The service-role key bypasses
// RLS; the function is the only entity that holds the key, so the table
// stays effectively private even though the rest of the app calls
// Supabase with the anon key.
//
// The service-role key MUST be set as `SUPABASE_SERVICE_ROLE_KEY` env var
// in the function deployment. Never expose it client-side. Supabase auto-
// injects `SUPABASE_URL` for Edge Functions; we read both from env.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

let cached: SupabaseClient | null = null;

/// Lazy singleton — first call creates, subsequent calls reuse. Cheap to
/// build but the client allocates a fetch wrapper, so don't rebuild per
/// request.
export function admin(): SupabaseClient {
  if (cached) return cached;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url) throw new Error("SUPABASE_URL env var not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var not set");

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
