import { getDb } from '../db/client';
import { randomToken } from './session';

export type User = {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  created_at: string;
  last_login_at: string | null;
};

/**
 * Who is allowed to sign in.
 *
 * An allowlist rather than "any Google account", because this app is deployed
 * on a public URL: without it, the sign-in button is an open invitation to
 * create an account and use somebody else's storage and API budget.
 *
 * Compared case-insensitively — Google addresses are not case sensitive, and an
 * allowlist that silently fails on `Foo@` vs `foo@` is worse than no allowlist,
 * because the owner believes it is working.
 */
export function allowedEmails(): string[] {
  return (process.env.EVERNOTION_ALLOWED_EMAILS ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Also accepts `@example.com` entries, meaning every address at that domain.
 *
 * Deliberately not matched against Google's `hd` claim: `hd` is absent for
 * personal accounts, and a domain written in the allowlist is a statement
 * about the address, which is what the person typing it means.
 */
export function isAllowedEmail(email: string, verified: boolean): boolean {
  // An unverified address proves nothing: anyone can put any string in a
  // profile. Matching it against the allowlist would be the whole gate.
  if (!verified) return false;

  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return false;

  const domain = address.slice(address.indexOf('@'));
  return allowedEmails().some((entry) => entry === address || entry === domain);
}

export function getUser(id: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

/**
 * Record a successful sign-in, creating the account on first use.
 *
 * Matched on Google's subject id rather than the address. `sub` is documented
 * as stable and never reused; an email address can be renamed, and matching on
 * it would hand somebody else's notes to whoever inherits their address.
 * The address is still refreshed on every login so the UI shows the current one.
 */
export function upsertUser(profile: {
  sub: string;
  email: string;
  name?: string | null;
  picture?: string | null;
}): User {
  const db = getDb();

  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM users WHERE google_sub = ?')
      .get(profile.sub) as User | undefined;

    if (existing) {
      db.prepare(
        `UPDATE users SET email = ?, name = ?, picture = ?, last_login_at = datetime('now')
          WHERE id = ?`,
      ).run(profile.email, profile.name ?? null, profile.picture ?? null, existing.id);
      return getUser(existing.id)!;
    }

    const isFirstUser = countUsers() === 0;
    const id = `u_${randomToken(12)}`;
    db.prepare(
      `INSERT INTO users (id, google_sub, email, name, picture, last_login_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(id, profile.sub, profile.email, profile.name ?? null, profile.picture ?? null);

    if (isFirstUser) claimUnownedRows(id);

    return getUser(id)!;
  })();
}

/**
 * Hand everything from before this app had accounts to its first user.
 *
 * An instance that ran as a single-user app has notes and PDFs with no owner.
 * Somebody has to end up with them, and the only defensible answer is whoever
 * set the instance up — which in practice is the first person able to sign in.
 *
 * Only ever runs while creating the first account, so there is no second user
 * it could take them away from.
 */
export function claimUnownedRows(ownerId: string): number {
  const db = getDb();
  let claimed = 0;
  for (const table of ['pages', 'attachments', 'chunks', 'search_docs']) {
    claimed += db
      .prepare(`UPDATE ${table} SET owner_id = ? WHERE owner_id IS NULL`)
      .run(ownerId).changes;
  }
  if (claimed > 0) {
    console.log(`[auth] ${claimed} pre-existing rows are now owned by ${ownerId}`);
  }
  return claimed;
}

/**
 * The implicit account used when there is no sign-in.
 *
 * Running on your own machine there is nobody to authenticate against, so a
 * login screen would be friction for no gain — but every note still needs an
 * owner, or the queries would need a second code path for the unowned case.
 * One local account keeps the data model identical in both modes.
 */
export const LOCAL_SUB = 'local';

export function localUser(): User {
  const existing = getDb()
    .prepare('SELECT * FROM users WHERE google_sub = ?')
    .get(LOCAL_SUB) as User | undefined;
  if (existing) return existing;

  return upsertUser({ sub: LOCAL_SUB, email: 'local@localhost', name: 'このパソコン' });
}
