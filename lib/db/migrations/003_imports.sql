-- Imports from Evernote and Notion.
--
-- A real export can hold thousands of notes and take minutes, so the work
-- happens on a background queue and the browser polls. Progress lives here
-- rather than in memory for two reasons: reloading the page must not lose
-- sight of a running import, and a restart has to be able to mark whatever was
-- in flight as failed instead of leaving it "running" forever.
CREATE TABLE imports (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,                       -- evernote|notion
  filename    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending|running|done|error
  -- `total` stays 0 until the count is known: an .enex is streamed, so the
  -- number of notes is only certain once the file has been read to the end.
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  notes       INTEGER NOT NULL DEFAULT 0,
  attachments INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX imports_owner_idx ON imports(owner_id, created_at DESC);
