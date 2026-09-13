import type { JSONContent } from '../editor/doc';

/** A binary that travelled with a note: an image, a PDF, anything attached. */
export type ImportedResource = {
  /** Name to show and to store the file under. */
  filename: string;
  mime: string;
  data: Uint8Array;
  /**
   * Evernote references a resource from the body by the MD5 of its bytes
   * rather than by name, so the hash is what joins the two together.
   */
  hash?: string;
};

/**
 * One note, after parsing and before it becomes a page.
 *
 * Deliberately source-agnostic: both the Evernote and the Notion reader
 * produce this, and only run.ts knows how to turn it into rows.
 */
export type ImportedNote = {
  title: string;
  /** Body as HTML. ENML already is; Notion markdown is converted first. */
  html: string;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  resources: ImportedResource[];
  /**
   * Where this note sat in the export, used to rebuild the page tree and to
   * resolve links between notes. Empty for a flat source like Evernote.
   */
  path?: string;
  parentPath?: string | null;
};

export type ImportSource = 'evernote' | 'notion';

export type ImportProgress = {
  id: string;
  source: ImportSource;
  filename: string;
  status: 'pending' | 'running' | 'done' | 'error';
  /** Notes seen, and notes written. total is 0 until the count is known. */
  total: number;
  done: number;
  notes: number;
  attachments: number;
  skipped: number;
  error: string | null;
  createdAt: string;
};
