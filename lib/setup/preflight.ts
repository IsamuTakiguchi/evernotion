import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db/client';

/**
 * Checks run once at startup for the two ways a deployment goes wrong quietly.
 *
 * Neither shows up as an error on its own: without a volume the app works
 * perfectly and then loses everything on the next deploy, and an unwritable
 * data directory surfaces only as a SQLite message about a directory that does
 * not exist — which is not what is wrong.
 */

export type PreflightIssue = {
  level: 'warning' | 'error';
  /** Shown in the UI. */
  message: string;
  /** Longer explanation for the server log. */
  detail: string;
};

/**
 * Is this path a mount point rather than a directory inside the image?
 *
 * A mount lives on a different device from its parent, which is the portable
 * way to tell. /proc/mounts is consulted as well because some container
 * filesystems can report the same device for a bind mount.
 */
export function isMountPoint(target: string): boolean {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) return true;

  try {
    const self = fs.statSync(resolved);
    const parent = fs.statSync(path.dirname(resolved));
    if (self.dev !== parent.dev) return true;
  } catch {
    return false;
  }

  try {
    return fs
      .readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .some((line) => line.split(' ')[1] === resolved);
  } catch {
    // Not Linux, or /proc is unavailable: the device comparison above stands.
    return false;
  }
}

/** Actually write, rather than trusting access(W_OK) — which lies when root. */
export function isWritable(target: string): boolean {
  const probe = path.join(target, `.evernotion-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when this process is running on a hosting platform rather than someone's
 * laptop. Used to decide whether an unauthenticated instance is acceptable.
 *
 * The markers below are all IDs that Railway injects into every build and
 * deployment, independent of domains, volumes or the git source. Names such as
 * RAILWAY_ENVIRONMENT are injected too, but an ID cannot be renamed out from
 * under this check, and getting this wrong fails open: a false negative here
 * serves the notes to anyone who finds the URL.
 *
 * For the same reason this errs towards "hosted" — the cost of a false
 * positive is a login prompt on a machine that did not need one.
 */
export function isHostedDeployment(): boolean {
  const markers = [
    process.env.RAILWAY_PROJECT_ID,
    process.env.RAILWAY_SERVICE_ID,
    process.env.RAILWAY_ENVIRONMENT_ID,
    // Other common platforms, so this is not Railway-specific.
    process.env.RENDER,
    process.env.FLY_APP_NAME,
    process.env.KUBERNETES_SERVICE_HOST,
    process.env.DYNO,
  ];
  if (markers.some((v) => v && v.trim())) return true;
  return process.env.EVERNOTION_HOSTED === '1';
}

/** The configured data directory, without creating it. */
function intendedDataDir(): string {
  return process.env.EVERNOTION_DATA_DIR
    ? path.resolve(process.env.EVERNOTION_DATA_DIR)
    : path.join(process.cwd(), 'data');
}

export function runPreflight(): PreflightIssue[] {
  const issues: PreflightIssue[] = [];

  let dir: string;
  try {
    // Also creates it. This runs before anything else in startup, so a failure
    // here must be reported rather than thrown — an exception at this point
    // would replace the diagnosis with a stack trace.
    dir = dataDir();
  } catch (err) {
    const target = intendedDataDir();
    return [{
      level: 'error',
      message: `データの保存先 ${target} を作成できません`,
      detail:
        `${target} could not be created: ${(err as Error).message}. ` +
        `Usually its parent is not writable by uid ${process.getuid?.() ?? '?'} — ` +
        'a mounted volume arrives root-owned. Nothing can be saved until this ' +
        'is fixed.',
    }];
  }

  if (!isWritable(dir)) {
    issues.push({
      level: 'error',
      message: `データの保存先 ${dir} に書き込めません`,
      detail:
        `${dir} is not writable by uid ${process.getuid?.() ?? '?'}. ` +
        'A mounted volume is usually root-owned, and the container must take ' +
        'ownership of it before dropping privileges — see docker-entrypoint.sh. ' +
        'Nothing can be saved until this is fixed.',
    });
  } else if (isHostedDeployment() && !isMountPoint(dir)) {
    issues.push({
      level: 'warning',
      message: `${dir} は永続ボリュームではありません。再デプロイで全データが消えます`,
      detail:
        `${dir} is a directory inside the container image, not a mounted volume. ` +
        'Notes, uploaded PDFs and the search index will be destroyed on the next ' +
        'deploy or restart. Attach a volume at this path.',
    });
  }

  return issues;
}
