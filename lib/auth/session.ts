/**
 * Session tokens.
 *
 * Uses Web Crypto only, so the same code runs in Proxy and in route handlers
 * without caring which runtime it landed on. No session store: the token
 * carries the user id and its own expiry, and is verified by signature.
 */

export const SESSION_COOKIE = 'ev_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Key under which a self-provisioned signing secret is stored. */
export const SECRET_SETTING = 'session_secret';

/**
 * Where the signing secret is published for the rest of the process.
 *
 * Startup resolves it once (reading or creating the stored one) and puts it
 * here, so this module never has to touch the database. That keeps it usable
 * from any runtime and avoids a database read on every request.
 *
 * Safe by construction: instrumentation's register() is documented to complete
 * before the server accepts requests, so this is populated before anything can
 * ask for it.
 */
export const RESOLVED_SECRET_ENV = 'EVERNOTION_RESOLVED_SECRET';

/**
 * How this instance decides who may use it.
 *
 *   google — Google sign-in, restricted to the allowlist
 *   open   — no login at all; nobody to authenticate against
 *   locked — reachable from the internet but not configured, so nothing is
 *            served. Failing closed is the whole point: the alternative is an
 *            instance that quietly hands every note to whoever finds the URL.
 */
export type AuthMode = 'google' | 'open' | 'locked';

export function googleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim(),
  );
}

export function authMode(): AuthMode {
  if (googleConfigured()) return 'google';
  // Imported lazily: preflight pulls in node:fs, which Proxy must not load on
  // a runtime that has no filesystem.
  return process.env.EVERNOTION_HOSTED_RESOLVED === '1' ? 'locked' : 'open';
}

function secret(): string {
  const configured = process.env.EVERNOTION_SECRET?.trim();
  if (configured) return configured;
  const resolved = process.env[RESOLVED_SECRET_ENV]?.trim();
  if (resolved) return resolved;
  // Only reachable before startup has run, which cannot happen for a request.
  throw new Error('session secret is not resolved yet');
}

/** A high-entropy value for signing, or for an id. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison, so a signature cannot be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Sign a short-lived value that is handed to a third party and comes back.
 *
 * Used for the OAuth state and the PKCE verifier: both have to survive a round
 * trip through Google, and neither is worth a server-side store.
 */
export async function signPayload(payload: string): Promise<string> {
  return `${payload}.${await hmac(secret(), payload)}`;
}

export async function verifyPayload(signed: string | undefined): Promise<string | null> {
  if (!signed) return null;
  const separator = signed.lastIndexOf('.');
  if (separator <= 0) return null;
  const payload = signed.slice(0, separator);
  const signature = signed.slice(separator + 1);
  return safeEqual(signature, await hmac(secret(), payload)) ? payload : null;
}

export async function createSessionToken(userId: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  // The user id is part of what is signed, so a session cannot be re-pointed
  // at somebody else's account by editing the cookie.
  return signPayload(`${userId}:${expiresAt}`);
}

/** The user this token belongs to, or null if it is absent, forged or expired. */
export async function sessionUserId(token: string | undefined): Promise<string | null> {
  const payload = await verifyPayload(token);
  if (!payload) return null;

  const split = payload.lastIndexOf(':');
  if (split <= 0) return null;

  const expiresAt = Number(payload.slice(split + 1));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  return payload.slice(0, split);
}

/** Read one cookie out of a plain Request. */
export function readCookie(req: Request, name: string): string | undefined {
  return (req.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function sessionCookie(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE);
}
