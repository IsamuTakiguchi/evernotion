-- Access tokens for the MCP endpoint.
--
-- These let Claude reach the notes without a browser session, which means a
-- token is a way past Google sign-in. Three consequences shape this table:
--
--   * Only a hash is stored. A copy of this database does not yield a working
--     token, the same way a leaked password table should not yield passwords.
--   * Revocation is a column, not a DELETE. Removing the row would also remove
--     the record of how long the token had been in use, which is the first
--     thing anyone asks after a leak.
--   * There are none by default. The endpoint is closed until somebody
--     deliberately issues one.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What it is for, in the person's own words, so they know which to revoke.
  name         TEXT NOT NULL DEFAULT '',
  -- SHA-256 of the token. The token itself is shown once and never stored.
  token_hash   TEXT NOT NULL UNIQUE,
  -- The leading characters, to tell two tokens apart in a list.
  prefix       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX api_tokens_owner_idx ON api_tokens(owner_id, created_at DESC);
