import { getDb } from '../db/client';
import { ingestPdf } from './ingest';
import { terminateOcrWorker } from './ocr';

type Job = { attachmentId: string; storagePath: string; filename: string };

type QueueState = {
  jobs: Job[];
  running: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Single in-process worker.
 *
 * Concurrency is 1 on purpose: OCR is CPU-bound WASM and better-sqlite3 is
 * synchronous, so running two ingests at once would just make both slower and
 * compete for the write lock.
 *
 * Held on globalThis because Next's dev server re-evaluates modules on every
 * HMR pass; without this a file save would spawn a second queue and the same
 * PDF would be OCR'd twice.
 */
const globalRef = globalThis as typeof globalThis & { __evernotionQueue?: QueueState };

function state(): QueueState {
  globalRef.__evernotionQueue ??= { jobs: [], running: false, idleTimer: null };
  return globalRef.__evernotionQueue;
}

const IDLE_SHUTDOWN_MS = 60_000;

export function enqueuePdf(job: Job): void {
  const q = state();
  if (q.jobs.some((j) => j.attachmentId === job.attachmentId)) return;
  q.jobs.push(job);
  void run();
}

function patch(attachmentId: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE attachments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), attachmentId);
}

async function run(): Promise<void> {
  const q = state();
  if (q.running) return;
  q.running = true;
  if (q.idleTimer) {
    clearTimeout(q.idleTimer);
    q.idleTimer = null;
  }

  try {
    while (q.jobs.length) {
      const job = q.jobs.shift()!;
      try {
        await ingestPdf(job.attachmentId, job.storagePath, job.filename, (p) => {
          const fields: Record<string, unknown> = {};
          if (p.status !== undefined) fields.status = p.status;
          if (p.progress !== undefined) fields.progress = p.progress;
          if (p.pageCount !== undefined) fields.page_count = p.pageCount;
          if (p.ocrPages !== undefined) fields.ocr_pages = p.ocrPages;
          if (p.error !== undefined) fields.error = p.error;
          patch(job.attachmentId, fields);
        });
      } catch (err) {
        console.error('[pdf-queue] ingest failed:', err);
        patch(job.attachmentId, {
          status: 'error',
          error: (err as Error).message.slice(0, 300),
        });
      }
    }
  } finally {
    q.running = false;
    // Release the tesseract worker after a quiet spell; it holds tens of MB.
    q.idleTimer = setTimeout(() => void terminateOcrWorker(), IDLE_SHUTDOWN_MS);
  }
}

/**
 * Re-queue anything left mid-flight by a restart, so a dev-server reload during
 * a long OCR resumes instead of stranding the file in 'extracting' forever.
 */
export function resumePendingJobs(): void {
  const rows = getDb()
    .prepare(
      `SELECT id, storage_path, filename FROM attachments
        WHERE status IN ('pending', 'extracting', 'ocr')`,
    )
    .all() as { id: string; storage_path: string; filename: string }[];

  for (const row of rows) {
    enqueuePdf({ attachmentId: row.id, storagePath: row.storage_path, filename: row.filename });
  }
}
