/**
 * Google sign-in, authorization-code flow with PKCE.
 *
 * Hand-rolled rather than pulled from a library: the whole flow is two
 * redirects and one POST, it needs no adapter or database schema of its own,
 * and the app already has HMAC-signed cookies to carry the round-trip state.
 */
import { randomToken, signPayload, verifyPayload } from './session';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Carries the PKCE verifier and CSRF state across the trip to Google. */
export const OAUTH_STATE_COOKIE = 'ev_oauth';
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export type GoogleProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

/**
 * The public origin of this instance.
 *
 * Never derived from the Host header. Google matches the redirect_uri exactly,
 * and a redirect_uri built from an attacker-supplied Host is how an
 * authorization code ends up somewhere it should not. On a hosted deployment
 * this must come from configuration; locally the request origin is fine
 * because there is no attacker between you and your own laptop.
 */
export function baseUrl(req: Request, hosted: boolean): string {
  const configured = process.env.EVERNOTION_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway}`;

  if (hosted) {
    throw new Error(
      'EVERNOTION_BASE_URL is not set. A public deployment must state its own ' +
        'URL rather than trust the Host header of an incoming request.',
    );
  }
  return new URL(req.url).origin;
}

export function redirectUri(req: Request, hosted: boolean): string {
  return `${baseUrl(req, hosted)}/api/auth/google/callback`;
}

/** base64url of a SHA-256 digest, which is what PKCE's S256 method means. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build the URL to send the browser to, plus the cookie value that has to come
 * back with it.
 *
 * `next` is where to land after signing in. It is checked here rather than on
 * return: only a path within this app is allowed, so the sign-in flow cannot be
 * used to bounce somebody to another site.
 */
export async function startAuthorization(opts: {
  redirectUri: string;
  next?: string | null;
}): Promise<{ url: string; stateCookie: string }> {
  const verifier = randomToken(32);
  const state = randomToken(16);
  const next = opts.next && /^\/(?!\/)/.test(opts.next) ? opts.next : '/';

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID!.trim());
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await s256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  // Ask for the account chooser every time. Without it a shared browser signs
  // straight back in as whoever used it last, which on a notes app means
  // opening somebody else's notes.
  url.searchParams.set('prompt', 'select_account');

  return {
    url: url.toString(),
    stateCookie: await signPayload(JSON.stringify({ state, verifier, next })),
  };
}

export type OAuthState = { state: string; verifier: string; next: string };

export async function readStateCookie(value: string | undefined): Promise<OAuthState | null> {
  const payload = await verifyPayload(value);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as OAuthState;
    if (!parsed.state || !parsed.verifier) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The claims of a JWT, without verifying its signature. See exchangeCode. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('id_token is not a JWT');
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  // atob gives one byte per character; Google's claims contain UTF-8 names.
  const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/**
 * Trade the authorization code for the user's identity.
 *
 * The id_token's signature is not checked against Google's JWKS, and that is
 * correct here rather than a shortcut: this response came back from a direct
 * HTTPS POST to Google's token endpoint, authenticated with our client secret.
 * Google documents that a token received this way is already trusted. (A JWT
 * arriving any other way — from the browser, say — would have to be verified.)
 *
 * The claims below are still checked, so a mix-up in configuration surfaces
 * here instead of as a session belonging to the wrong project.
 */
export async function exchangeCode(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<GoogleProfile> {
  const clientId = process.env.GOOGLE_CLIENT_ID!.trim();

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: opts.code,
      client_id: clientId,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: opts.verifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Google's error body names the misconfiguration (redirect_uri_mismatch,
    // invalid_client); losing it would make this very hard to diagnose.
    throw new Error(`Google token exchange failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const token = (await res.json()) as { id_token?: string };
  if (!token.id_token) throw new Error('Google response carried no id_token');

  const claims = decodeJwtPayload(token.id_token);

  if (!ISSUERS.includes(String(claims.iss))) {
    throw new Error(`unexpected id_token issuer: ${String(claims.iss)}`);
  }
  if (String(claims.aud) !== clientId) {
    throw new Error('id_token was issued for a different client');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
    throw new Error('id_token has already expired');
  }
  if (!claims.sub || !claims.email) {
    throw new Error('id_token carried no subject or email');
  }

  return {
    sub: String(claims.sub),
    email: String(claims.email),
    // Google sends this as a boolean, but has historically also sent the
    // string "true"; treat anything else as unverified.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name ? String(claims.name) : null,
    picture: claims.picture ? String(claims.picture) : null,
  };
}
