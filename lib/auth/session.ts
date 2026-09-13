/**
 * Session tokens for the optional password gate.
 *
 * Uses Web Crypto only, so the same code runs in middleware (edge runtime) and
 * in route handlers (Node). No dependency, no session store: the token carries
 * its own expiry and is verified by signature.
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

/** The configured password, or null when the app is left open. */
export function configuredPassword(): string | null {
  const value = process.env.EVERNOTION_PASSWORD?.trim();
  return value ? value : null;
}

export function isProtected(): boolean {
  return configuredPassword() !== null;
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
