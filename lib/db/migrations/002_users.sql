-- Multiple users, each with their own private notes.
--
-- Identity comes from Google; this table is the local record of who has been
-- let in. google_sub is Google's stable subject id and is what a returning
-- login is matched on — an email address can be changed or reassigned, a sub
-- cannot. The email is kept because it is what the allowlist is written in
-- terms of, and what a person recognises themselves by.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  name          TEXT,
  picture       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Case-insensitively unique: Gmail addresses are not case sensitive, and two
-- rows differing only in case would be two accounts to the database and one
-- person to everybody else.
CREATE UNIQUE INDEX users_email_idx ON users(lower(email));

-- Ownership.
--
-- Denormalised onto each table that is queried directly rather than reached
-- through its parent. search_docs and chunks matter most: full-text search and
-- the vector scan read them without touching `pages` at all, so without a
-- column here the filter would have to be a join that is easy to forget.
--
-- Nullable, for exactly one reason: rows created before this migration have no
-- owner yet, and there are no users at the moment it runs. The first person to
-- log in claims them (see claimUnownedRows). After that every insert sets it.
ALTER TABLE pages       ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE attachments ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE chunks      ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE search_docs ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;

-- Every listing is "this user's, ordered by something", so the owner belongs
-- first in each index.
CREATE INDEX pages_owner_idx        ON pages(owner_id, updated_at DESC);
CREATE INDEX pages_owner_parent_idx ON pages(owner_id, parent_id, sort_order);
CREATE INDEX attachments_owner_idx  ON attachments(owner_id);
CREATE INDEX chunks_owner_idx       ON chunks(owner_id);
CREATE INDEX search_docs_owner_idx  ON search_docs(owner_id);

-- `tags` is deliberately left alone, as a shared dictionary of tag *names*
-- with no owner of its own. Rebuilding it to add one would mean dropping a
-- table that page_tags references, and with foreign keys on that cascades the
-- tag assignments away with it. Ownership of a tag is instead whether you have
-- a page carrying it, which every read path expresses as a join through
-- page_tags to pages. A name on its own is not anybody's data until a page
-- of theirs uses it.
