/**
 * Session tokens for the optional password gate.
 *
 * Uses Web Crypto only, so the same code runs in Proxy and in route handlers
 * without caring which runtime it landed on. No dependency, no session store:
 * the token carries its own expiry and is verified by signature.
 */

export const SESSION_COOKIE = 'ev_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * The password itself is the signing key. That is deliberate: changing the
 * password then invalidates every existing session, which is the behaviour
 * someone changing a password actually wants.
 */
function secretFor(password: string): string {
  return process.env.EVERNOTION_SECRET?.trim() || password;
}

/** Key under which a self-provisioned password is stored. */
export const GENERATED_PASSWORD_SETTING = 'generated_password';

/**
 * Where a self-provisioned password is published for the rest of the process.
 *
 * Startup resolves the password once (reading or creating the stored one) and
 * puts it here, so this module never has to touch the database. That keeps it
 * usable from any runtime and avoids a database read on every request.
 *
 * Safe by construction: instrumentation's register() is documented to complete
 * before the server accepts requests, so this is populated before anything can
 * ask for it.
 */
export const RESOLVED_PASSWORD_ENV = 'EVERNOTION_RESOLVED_PASSWORD';

/**
 * The password guarding this instance, or null when it is deliberately open.
 *
 * Resolution order:
 *   1. EVERNOTION_PASSWORD — an explicit choice always wins
 *   2. a password this instance generated for itself on first boot
 *   3. null, which means no login at all
 *
 * Step 2 is what lets a public deployment be protected without anyone having to
 * remember to set a variable.
 */
export function configuredPassword(): string | null {
  const fromEnv = process.env.EVERNOTION_PASSWORD?.trim();
  if (fromEnv) return fromEnv;

  const resolved = process.env[RESOLVED_PASSWORD_ENV]?.trim();
  return resolved ? resolved : null;
}

export function isProtected(): boolean {
  return configuredPassword() !== null;
}

/** Whether the active password was generated rather than configured. */
export function isGeneratedPassword(): boolean {
  return !process.env.EVERNOTION_PASSWORD?.trim() && configuredPassword() !== null;
}

/**
 * A password that is easy to copy out of a deploy log and still strong.
 *
 * Avoids the characters that get misread when someone retypes from a log
 * (0/O, 1/l/I) — a password nobody can transcribe just gets replaced by a
 * weaker one.
 */
export function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(24);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((n) => alphabet[n % alphabet.length]);
  // Grouped, so it survives being read off a screen.
  return [0, 6, 12, 18].map((i) => chars.slice(i, i + 6).join('')).join('-');
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

export async function createSessionToken(password: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = String(expiresAt);
  return `${payload}.${await hmac(secretFor(password), payload)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  password: string,
): Promise<boolean> {
  if (!token) return false;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  return safeEqual(signature, await hmac(secretFor(password), payload));
}

/** Compare a submitted password without leaking its length through timing. */
export async function passwordMatches(submitted: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmac(expected, submitted), hmac(expected, expected)]);
  return safeEqual(a, b);
}
