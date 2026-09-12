-- Core note pages. Tiptap JSON in doc_json, derived searchable text in plain_text.
CREATE TABLE pages (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES pages(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  icon        TEXT,
  doc_json    TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',
  plain_text  TEXT NOT NULL DEFAULT '',
  sort_order  REAL NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX pages_parent_idx ON pages(parent_id, sort_order);
CREATE INDEX pages_updated_idx ON pages(updated_at DESC);
CREATE INDEX pages_title_idx ON pages(title);

-- Uploaded files (PDFs above all).
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  page_id      TEXT REFERENCES pages(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  page_count   INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|extracting|ocr|ready|error
  progress     REAL NOT NULL DEFAULT 0,
  ocr_pages    INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX attachments_page_idx ON attachments(page_id);

-- Text of each PDF page, from the text layer or from OCR.
CREATE TABLE pdf_pages (
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  page_no       INTEGER NOT NULL,
  text          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'text', -- text|ocr
  PRIMARY KEY (attachment_id, page_no)
);

-- Wikilink edges. target_page_id is NULL while the target page does not exist yet.
CREATE TABLE links (
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_title   TEXT NOT NULL,
  target_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  PRIMARY KEY (source_page_id, target_title)
);
CREATE INDEX links_target_idx ON links(target_page_id);
CREATE INDEX links_target_title_idx ON links(target_title);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source  TEXT NOT NULL DEFAULT 'manual', -- manual|ai
  PRIMARY KEY (page_id, tag_id)
);

-- RAG chunks. embedding is a Float32Array(384) stored as a BLOB.
CREATE TABLE chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,             -- page|pdf
  page_id       TEXT REFERENCES pages(id) ON DELETE CASCADE,
  attachment_id TEXT REFERENCES attachments(id) ON DELETE CASCADE,
  pdf_page_no   INTEGER,
  ord           INTEGER NOT NULL DEFAULT 0,
  text          TEXT NOT NULL,
  hash          TEXT NOT NULL,
  embedding     BLOB,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX chunks_page_idx ON chunks(page_id);
CREATE INDEX chunks_attachment_idx ON chunks(attachment_id);
CREATE INDEX chunks_hash_idx ON chunks(hash);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Full-text search.
--
-- Japanese has no word spaces, and FTS5's own tokenizers cannot segment it:
-- unicode61 treats a whole run of kanji as one token, and trigram structurally
-- cannot answer a 2-character query (予算, 契約, 会議) -- which is the single
-- most common Japanese query shape. So text is turned into overlapping
-- bigrams in application code (lib/search/ngram.ts) before indexing, and a
-- query becomes a *phrase* of consecutive bigrams. FTS5's positional phrase
-- matching then enforces adjacency, which gives true substring semantics.
--
-- detail=full is required: the whole scheme rests on phrase queries.
-- content='' keeps FTS from storing a second copy of the (2x larger) n-gram
-- text; contentless_delete=1 is what makes re-indexing a row possible.

-- The row a hit resolves to, holding display text at its original width/case.
CREATE TABLE search_docs (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,             -- page|pdf
  page_id     TEXT REFERENCES pages(id) ON DELETE CASCADE,
  attachment_id TEXT REFERENCES attachments(id) ON DELETE CASCADE,
  pdf_page_no INTEGER,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX search_docs_page_idx ON search_docs(page_id) WHERE kind = 'page';
CREATE UNIQUE INDEX search_docs_pdf_idx  ON search_docs(attachment_id, pdf_page_no) WHERE kind = 'pdf';

CREATE VIRTUAL TABLE fts_docs USING fts5(
  title_ng,
  body_ng,
  content = '',
  contentless_delete = 1,
  detail = full,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);
