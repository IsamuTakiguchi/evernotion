/**
 * Access tokens for the MCP endpoint.
 *
 * A token stands in for signing in, so it is treated like a password: shown
 * once at creation, stored only as a hash, and revoked rather than deleted so
 * the record of its use survives the revocation.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';

import { getDb } from '../db/client';

/** Marks the string as ours in a config file full of other people's secrets. */
const PREFIX = 'evn_';

export type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

function hash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toToken(row: Record<string, unknown>): ApiToken {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    prefix: String(row.prefix ?? ''),
    createdAt: String(row.created_at),
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
  };
}

/**
 * Issue a token.
 *
 * The plaintext comes back exactly once, in the return value. Nothing writes
 * it anywhere — not the database, not the log — so losing it means issuing
 * another one, which is the correct trade for a credential that bypasses
 * sign-in.
 */
export function createToken(ownerId: string, name: string): { token: ApiToken; secret: string } {
  const secret = `${PREFIX}${randomBytes(32).toString('hex')}`;
  const id = `tok_${nanoid(10)}`;

  getDb()
    .prepare(
      `INSERT INTO api_tokens (id, owner_id, name, token_hash, prefix)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, ownerId, name.trim().slice(0, 100), hash(secret), secret.slice(0, PREFIX.length + 6));

  return { token: getToken(ownerId, id)!, secret };
}

export function getToken(ownerId: string, id: string): ApiToken | null {
  const row = getDb()
    .prepare('SELECT * FROM api_tokens WHERE id = ? AND owner_id = ?')
    .get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? toToken(row) : null;
}

export function listTokens(ownerId: string): ApiToken[] {
  return (getDb()
    .prepare('SELECT * FROM api_tokens WHERE owner_id = ? ORDER BY created_at DESC')
    .all(ownerId) as Record<string, unknown>[]).map(toToken);
}

/** Revoke a token. Returns false when it is not this owner's to revoke. */
export function revokeToken(ownerId: string, id: string): boolean {
  return getDb()
    .prepare(
      `UPDATE api_tokens SET revoked_at = datetime('now')
        WHERE id = ? AND owner_id = ? AND revoked_at IS NULL`,
    )
    .run(id, ownerId).changes > 0;
}

/**
 * The account a presented token belongs to, or null.
 *
 * Looked up by hash rather than compared row by row: the stored value is a
 * digest, so an attacker learning the timing of a digest comparison learns
 * nothing they could invert. The digests are still compared in constant time
 * once found, because it costs nothing to do so.
 */
export function ownerForToken(presented: string | undefined): string | null {
  const token = presented?.trim();
  if (!token || !token.startsWith(PREFIX)) return null;

  const digest = hash(token);
  const row = getDb()
    .prepare('SELECT id, owner_id, token_hash, revoked_at FROM api_tokens WHERE token_hash = ?')
    .get(digest) as
    | { id: string; owner_id: string; token_hash: string; revoked_at: string | null }
    | undefined;

  if (!row || row.revoked_at) return null;

  const a = Buffer.from(row.token_hash, 'hex');
  const b = Buffer.from(digest, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  touch(row.id);
  return row.owner_id;
}

/**
 * Record that a token was used, at most once a minute.
 *
 * Every MCP call would otherwise be a write, and the value of this column is
 * "roughly when was this last used", which a minute's resolution answers.
 */
function touch(id: string): void {
  getDb()
    .prepare(
      `UPDATE api_tokens SET last_used_at = datetime('now')
        WHERE id = ?
          AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))`,
    )
    .run(id);
}

/** Read the bearer token from an Authorization header. */
export function bearerToken(req: Request): string | undefined {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}
