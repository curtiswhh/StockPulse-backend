// _shared/apns.ts
// Apple Push Notification Service client for Edge Functions.
//
// Token-based auth (.p8 key). Signs an ES256 JWT per provider key, caches
// it for ~50 minutes (Apple rejects tokens older than 1h), sends HTTP/2
// POSTs to APNs. Returns a typed result that /dispatch maps to status
// transitions on the notifications row.
//
// Required env vars (set in Studio → Edge Functions → Settings):
//   APNS_KEY_P8       — full PEM contents of the .p8 file (multi-line)
//   APNS_KEY_ID       — 10-char Key ID from Apple Developer
//   APNS_TEAM_ID      — 10-char Team ID from Apple Developer
//   APNS_BUNDLE_ID    — e.g. com.curtis.StockPulse
//
// Endpoints:
//   api.push.apple.com         — production builds (App Store, TF release)
//   api.sandbox.push.apple.com — debug builds (Xcode-installed, TF pre-release)
// Per-token env is stored on users.apns_env; iOS sets it at registration
// (see PR 4 → 'production' for App Store builds, 'sandbox' for debug).

import { create, getNumericDate, Header } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

// ============================================================
// Env
// ============================================================

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} env var not set`);
  return v;
}

const APNS_BUNDLE_ID = () => env("APNS_BUNDLE_ID");
const APNS_KEY_ID    = () => env("APNS_KEY_ID");
const APNS_TEAM_ID   = () => env("APNS_TEAM_ID");
const APNS_KEY_P8    = () => env("APNS_KEY_P8");

// ============================================================
// JWT signing
// ============================================================

interface CachedToken {
  jwt: string;
  expiresAt: number; // epoch ms when we'll refresh (50 min after issue)
}

let cachedToken: CachedToken | null = null;

/// Parse the PEM-formatted .p8 contents into a CryptoKey usable by djwt.
/// Apple's .p8 is a PKCS#8 ES256 (P-256) private key. The PEM header/footer
/// + line breaks need stripping before base64 decode.
async function importP8Key(p8Pem: string): Promise<CryptoKey> {
  // Strip header/footer/whitespace. Match both -----BEGIN PRIVATE KEY-----
  // and -----BEGIN EC PRIVATE KEY----- (Apple uses the first form).
  const b64 = p8Pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");

  // Base64 → ArrayBuffer
  const binary = atob(b64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);

  return await crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/// Build an APNs provider JWT. Apple wants ES256, alg=ES256, kid=Key ID,
/// iss=Team ID, iat=now. Apple rejects tokens > 1h old; we refresh at 50min.
async function buildJwt(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.jwt;

  const key = await importP8Key(APNS_KEY_P8());
  const header: Header = { alg: "ES256", kid: APNS_KEY_ID(), typ: "JWT" };
  const payload = {
    iss: APNS_TEAM_ID(),
    iat: getNumericDate(0),
  };
  const jwt = await create(header, payload, key);

  cachedToken = { jwt, expiresAt: now + 50 * 60 * 1000 };
  return jwt;
}

/// For testing or forced rotation. Clears the cached JWT so the next send
/// builds a fresh one. Currently unused by /dispatch but handy in smoke
/// tests if you rotate APNS_KEY_P8.
export function clearJwtCache(): void {
  cachedToken = null;
}

// ============================================================
// Send
// ============================================================

export interface ApnsPayload {
  /// User-visible title (e.g. "AAPL up 5.2%").
  title: string;
  /// User-visible body (e.g. "Now $214.30 · was $203.71").
  body: string;
  /// Custom data merged into the aps payload. iOS reads from
  /// userInfo for deep linking, etc.
  data?: Record<string, unknown>;
  /// 'production' (App Store / TF release) or 'sandbox' (debug / TF beta).
  env: "production" | "sandbox";
  /// APNs topic (the app's bundle ID). Falls back to APNS_BUNDLE_ID env.
  topic?: string;
}

export type ApnsResult =
  | { kind: "sent"; }
  | { kind: "bad_token"; reason: string }      // BadDeviceToken / Unregistered → clear users.apns_token
  | { kind: "expired_jwt" }                     // ExpiredProviderToken → retry next tick with fresh JWT
  | { kind: "rate_limited" }                    // 429 → retry next tick
  | { kind: "transient"; status: number; body: string }  // 5xx → retry next tick
  | { kind: "fatal"; status: number; body: string };     // other 4xx → drop

/// Send one push. Caller is responsible for status transitions on the
/// notifications row based on the returned kind.
export async function sendApns(token: string, payload: ApnsPayload): Promise<ApnsResult> {
  const host = payload.env === "production"
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com";

  const body = {
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
    },
    ...(payload.data ?? {}),
  };

  let jwt: string;
  try {
    jwt = await buildJwt();
  } catch (e) {
    // Misconfigured env vars are fatal — no point retrying.
    return { kind: "fatal", status: 0, body: (e as Error).message };
  }

  let res: Response;
  try {
    res = await fetch(`https://${host}/3/device/${token}`, {
      method: "POST",
      headers: {
        "authorization": `bearer ${jwt}`,
        "apns-topic": payload.topic ?? APNS_BUNDLE_ID(),
        "apns-push-type": "alert",
        "apns-priority": "10",        // immediate delivery; 5 = throttled
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Network failure — treat as transient.
    return { kind: "transient", status: 0, body: (e as Error).message };
  }

  if (res.status === 200) return { kind: "sent" };

  // Apple returns a JSON body with { reason: "..." } on errors.
  let reason = "";
  try {
    const t = await res.text();
    try {
      reason = JSON.parse(t).reason ?? t;
    } catch {
      reason = t;
    }
  } catch {
    reason = "<no body>";
  }

  // Map Apple's error reasons to action.
  // Full list: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns#Handle-the-response
  if (res.status === 400 && reason === "BadDeviceToken")    return { kind: "bad_token", reason };
  if (res.status === 410 && reason === "Unregistered")      return { kind: "bad_token", reason };
  if (res.status === 400 && reason === "DeviceTokenNotForTopic")
                                                            return { kind: "bad_token", reason };
  if (res.status === 403 && reason === "ExpiredProviderToken") {
    clearJwtCache();
    return { kind: "expired_jwt" };
  }
  if (res.status === 429)                                   return { kind: "rate_limited" };
  if (res.status >= 500)                                    return { kind: "transient", status: res.status, body: reason };
  return { kind: "fatal", status: res.status, body: reason };
}