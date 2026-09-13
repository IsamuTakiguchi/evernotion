import { getDb } from '../db/client';
import { resumePendingJobs } from '../pdf/queue';
import { seedWelcomeNotes } from './seed';
import { ensureModels, hasTessdata } from './models.mjs';

export type SetupPhase = 'starting' | 'downloading' | 'ready' | 'error';

export type SetupState = {
  phase: SetupPhase;
  /** Human-readable note on what is happening, shown in the UI. */
  message: string;
  /** Whether the offline models are present and usable. */
  modelsReady: boolean;
  seeded: boolean;
  error: string | null;
};

type BootstrapGlobal = typeof globalThis & {
  __evernotionSetup?: SetupState;
  __evernotionBootstrapped?: boolean;
};

const g = globalThis as BootstrapGlobal;

function state(): SetupState {
  g.__evernotionSetup ??= {
    phase: 'starting',
    message: '起動中…',
    modelsReady: false,
    seeded: false,
    error: null,
  };
  return g.__evernotionSetup;
}

export function setupState(): SetupState {
  return { ...state() };
}

/**
 * Everything the app needs before it is usable, run once at server startup.
 *
 * Deliberately does not block: the notes, the editor and keyword search all
 * work while models are still downloading, so making the first page load wait
 * on ~170MB would trade a working app for a spinner.
 */
export function bootstrap(): void {
  if (g.__evernotionBootstrapped) return;
  g.__evernotionBootstrapped = true;

  const s = state();

  try {
    // Opening the database applies migrations.
    getDb();
    s.seeded = seedWelcomeNotes();

    // Any ingest interrupted by a restart is stranded in a non-terminal state;
    // without this its file would sit at "解析中" forever.
    resumePendingJobs();
  } catch (err) {
    s.phase = 'error';
    s.error = (err as Error).message;
    s.message = '起動時の初期化に失敗しました';
    console.error('[bootstrap]', err);
    return;
  }

  if (hasTessdata()) {
    // Tessdata on disk means warmup already ran; the embedding model still
    // resolves lazily, so this only avoids re-reporting a download.
    s.phase = 'ready';
    s.modelsReady = true;
    s.message = '準備完了';
    return;
  }

  s.phase = 'downloading';
  s.message = 'モデルを準備しています（初回のみ）';

  void ensureModels({
    onProgress: (message: string) => {
      s.message = message;
    },
  })
    .then(() => {
      s.phase = 'ready';
      s.modelsReady = true;
      s.message = '準備完了';
    })
    .catch((err: Error) => {
      // Offline or a blocked host: the app stays fully usable for notes, PDFs
      // with a text layer, and keyword search. Only OCR and semantic search
      // need these files, and both retry on next use.
      s.phase = 'error';
      s.error = err.message;
      s.message = 'モデルの取得に失敗しました（ネットワークを確認してください）';
      console.error('[bootstrap] model download failed:', err.message);
    });
}
