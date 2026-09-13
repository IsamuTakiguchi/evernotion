import { getDb } from '../db/client';
import { getSetting, setSetting } from '../db/queries';
import { resumePendingJobs } from '../pdf/queue';
import {
  GENERATED_PASSWORD_SETTING, RESOLVED_PASSWORD_ENV, generatePassword,
} from '../auth/session';
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

    resolvePassword();
    s.seeded = seedWelcomeNotes();

    // Any ingest interrupted by a restart is stranded in a non-terminal state;
    // without this its file would sit at "解析中" forever.
    resumePendingJobs();
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
 * Settle on a password for this instance and publish it for the rest of the
 * process.
 *
 * A note app on a public URL with no login is not a usable default: anyone who
 * learns the address can read everything and upload files. Rather than demand
 * that an environment variable be remembered, a hosted instance that has none
 * generates one, keeps it on the volume, and prints it once so it can be
 * retrieved from the deploy log.
 *
 * Run locally, nothing happens: there is nobody to authenticate against, and a
 * login prompt on your own machine is friction for no gain.
 */
function resolvePassword(): void {
  if (process.env.EVERNOTION_PASSWORD?.trim()) return;

  const stored = getSetting(GENERATED_PASSWORD_SETTING)?.trim();
  if (stored) {
    process.env[RESOLVED_PASSWORD_ENV] = stored;
    return;
  }

  if (!isHostedDeployment()) return;

  const password = generatePassword();
  setSetting(GENERATED_PASSWORD_SETTING, password);
  process.env[RESOLVED_PASSWORD_ENV] = password;

  // The only time this is ever printed. It is stored from here on, so a
  // restart reuses it rather than generating a new one.
  console.log(
    [
      '',
      '='.repeat(64),
      '  Evernotion: no EVERNOTION_PASSWORD was set, so one was generated.',
      '',
      `      ${password}`,
      '',
      '  Log in with it, then keep it somewhere safe — this is the only time',
      '  it is printed. To choose your own instead, set EVERNOTION_PASSWORD',
      '  as an environment variable; it takes precedence from then on.',
      '='.repeat(64),
      '',
    ].join('\n'),
  );
}
