import { getDb } from '../db/client';
import { getSetting, setSetting } from '../db/queries';
import { resumePendingJobs } from '../pdf/queue';
import { failInterruptedImports } from '../import/run';
import { RESOLVED_SECRET_ENV, SECRET_SETTING, authMode, randomToken } from '../auth/session';
import { localUser } from '../auth/users';
import { seedWelcomeNotes } from './seed';
import { runPreflight, isHostedDeployment, type PreflightIssue } from './preflight';
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
  /** Deployment problems that would otherwise fail silently. */
  issues: PreflightIssue[];
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
    issues: [],
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

  // Before the database, deliberately. An unwritable data directory makes
  // SQLite report "unable to open database file", which sends whoever reads
  // the log looking for a missing file rather than a permissions problem — so
  // the real explanation has to be printed first, while there is still a
  // chance to print anything at all.
  s.issues = runPreflight();
  for (const issue of s.issues) {
    const line = `[setup] ${issue.level.toUpperCase()}: ${issue.detail}`;
    if (issue.level === 'error') console.error(line);
    else console.warn(line);
  }

  try {
    // Opening the database applies migrations.
    getDb();

    // Published before anything can ask for it: register() is documented to
    // finish before the server accepts a request.
    process.env.EVERNOTION_HOSTED_RESOLVED = isHostedDeployment() ? '1' : '0';
    resolveSecret();

    // With accounts, the starting notes belong to an account and are created on
    // first sign-in. Running locally there is only ever the one implicit user,
    // so it still happens here.
    s.seeded = authMode() === 'open' ? seedWelcomeNotes(localUser().id) : false;

    // Any ingest interrupted by a restart is stranded in a non-terminal state;
    // without this its file would sit at "解析中" forever.
    resumePendingJobs();

    // An import cannot be resumed the same way — its uploaded file went with
    // the temp directory — so it is marked failed rather than left running.
    failInterruptedImports();
  } catch (err) {
    s.phase = 'error';
    // A preflight error explains the failure; the exception is only its
    // symptom. Report the cause, and keep the raw message for the log.
    const fatal = s.issues.find((issue) => issue.level === 'error');
    s.error = fatal ? fatal.detail : (err as Error).message;
    s.message = fatal ? fatal.message : '起動時の初期化に失敗しました';
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


/**
 * Settle on the key that signs session cookies, and publish it for the process.
 *
 * Kept on the volume rather than regenerated per boot, or every restart would
 * sign everybody out. EVERNOTION_SECRET overrides it, which is what you want
 * when running more than one instance — though this app cannot, because its
 * volume allows only one.
 */
function resolveSecret(): void {
  if (process.env.EVERNOTION_SECRET?.trim()) return;

  const stored = getSetting(SECRET_SETTING)?.trim();
  if (stored) {
    process.env[RESOLVED_SECRET_ENV] = stored;
    return;
  }

  const generated = randomToken(32);
  setSetting(SECRET_SETTING, generated);
  process.env[RESOLVED_SECRET_ENV] = generated;
}
