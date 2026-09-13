import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isMountPoint, isWritable, isHostedDeployment, runPreflight } from '@/lib/setup/preflight';
import {
  RESOLVED_PASSWORD_ENV, configuredPassword, generatePassword, isGeneratedPassword,
} from '@/lib/auth/session';

/** Run a body with a specific set of environment variables, then restore. */
function withEnv(vars: Record<string, string | undefined>, body: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evernotion-test-'));
}

// ------------------------------------------------------------- preflight ---

test('isMountPoint: a real mount is detected', () => {
  // /proc is a mount on every Linux box and is not in any container image.
  assert.equal(isMountPoint('/proc'), true);
});

test('isMountPoint: an ordinary directory is not a mount', () => {
  const dir = tmpdir();
  const inner = path.join(dir, 'data');
  fs.mkdirSync(inner);
  assert.equal(isMountPoint(inner), false);
});

test('isMountPoint: the root of the filesystem counts as mounted', () => {
  assert.equal(isMountPoint('/'), true);
});

test('isWritable: probes by writing, not by asking', () => {
  const dir = tmpdir();
  assert.equal(isWritable(dir), true);
  // The probe must clean up after itself, or the data directory slowly fills
  // with one file per boot.
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.startsWith('.evernotion-write-probe')),
    [],
  );
});

test('isWritable: a directory that does not exist is not writable', () => {
  assert.equal(isWritable(path.join(tmpdir(), 'absent')), false);
});

test('isHostedDeployment: any Railway id marks a deployment', () => {
  for (const marker of ['RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_ENVIRONMENT_ID']) {
    withEnv(
      {
        RAILWAY_PROJECT_ID: undefined, RAILWAY_SERVICE_ID: undefined,
        RAILWAY_ENVIRONMENT_ID: undefined, RENDER: undefined, FLY_APP_NAME: undefined,
        KUBERNETES_SERVICE_HOST: undefined, DYNO: undefined, EVERNOTION_HOSTED: undefined,
        [marker]: 'abc-123',
      },
      () => assert.equal(isHostedDeployment(), true, marker),
    );
  }
});

test('isHostedDeployment: a laptop is not a deployment', () => {
  withEnv(
    {
      RAILWAY_PROJECT_ID: undefined, RAILWAY_SERVICE_ID: undefined,
      RAILWAY_ENVIRONMENT_ID: undefined, RENDER: undefined, FLY_APP_NAME: undefined,
      KUBERNETES_SERVICE_HOST: undefined, DYNO: undefined, EVERNOTION_HOSTED: undefined,
    },
    () => assert.equal(isHostedDeployment(), false),
  );
});

test('isHostedDeployment: an empty marker does not count', () => {
  withEnv(
    {
      RAILWAY_PROJECT_ID: '   ', RAILWAY_SERVICE_ID: undefined,
      RAILWAY_ENVIRONMENT_ID: undefined, RENDER: undefined, FLY_APP_NAME: undefined,
      KUBERNETES_SERVICE_HOST: undefined, DYNO: undefined, EVERNOTION_HOSTED: undefined,
    },
    () => assert.equal(isHostedDeployment(), false),
  );
});

test('runPreflight: a hosted deployment with no volume is warned about', () => {
  const dir = path.join(tmpdir(), 'data');
  withEnv({ EVERNOTION_DATA_DIR: dir, EVERNOTION_HOSTED: '1' }, () => {
    const issues = runPreflight();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].level, 'warning');
    // The user-facing message has to say what is lost, not name a syscall.
    assert.match(issues[0].message, /消え/);
    assert.match(issues[0].detail, /volume/i);
  });
});

test('runPreflight: a data directory that cannot be created reports the cause', () => {
  // The real shape of this is a root-owned volume under a non-root process.
  // Preflight must return the reason rather than throw: it runs before the
  // database is opened precisely so that it, not SQLite's "unable to open
  // database file", is the first thing in the log.
  // Blocked with a file where a directory needs to be, rather than with
  // permissions: the suite runs as root under Docker, and root would simply
  // ignore the mode and make the directory anyway.
  const blocker = path.join(tmpdir(), 'blocker');
  fs.writeFileSync(blocker, 'not a directory');

  withEnv({ EVERNOTION_DATA_DIR: path.join(blocker, 'data') }, () => {
    const issues = runPreflight();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].level, 'error');
    assert.match(issues[0].message, /作成できません/);
    assert.match(issues[0].detail, /could not be created/);
  });
});

test('runPreflight: the same directory locally is not a problem', () => {
  const dir = path.join(tmpdir(), 'data');
  withEnv(
    {
      EVERNOTION_DATA_DIR: dir, EVERNOTION_HOSTED: undefined,
      RAILWAY_PROJECT_ID: undefined, RAILWAY_SERVICE_ID: undefined,
      RAILWAY_ENVIRONMENT_ID: undefined, RENDER: undefined, FLY_APP_NAME: undefined,
      KUBERNETES_SERVICE_HOST: undefined, DYNO: undefined,
    },
    () => assert.deepEqual(runPreflight(), []),
  );
});

// -------------------------------------------------------------- password ---

test('generatePassword: shaped for copying out of a deploy log', () => {
  const password = generatePassword();
  assert.match(password, /^[a-zA-Z2-9]{6}(-[a-zA-Z2-9]{6}){3}$/);
  // 0/O and 1/l/I are the characters people mistype when reading off a screen.
  assert.equal(/[0O1lI]/.test(password), false, password);
});

test('generatePassword: does not repeat itself', () => {
  const seen = new Set(Array.from({ length: 50 }, () => generatePassword()));
  assert.equal(seen.size, 50);
});

test('configuredPassword: an explicit password wins over a generated one', () => {
  withEnv({ EVERNOTION_PASSWORD: 'chosen', [RESOLVED_PASSWORD_ENV]: 'generated' }, () => {
    assert.equal(configuredPassword(), 'chosen');
    assert.equal(isGeneratedPassword(), false);
  });
});

test('configuredPassword: falls back to the generated one', () => {
  withEnv({ EVERNOTION_PASSWORD: undefined, [RESOLVED_PASSWORD_ENV]: 'generated' }, () => {
    assert.equal(configuredPassword(), 'generated');
    assert.equal(isGeneratedPassword(), true);
  });
});

test('configuredPassword: no password at all means an open instance', () => {
  withEnv({ EVERNOTION_PASSWORD: undefined, [RESOLVED_PASSWORD_ENV]: undefined }, () => {
    assert.equal(configuredPassword(), null);
    assert.equal(isGeneratedPassword(), false);
  });
});

test('configuredPassword: whitespace is not a password', () => {
  withEnv({ EVERNOTION_PASSWORD: '   ', [RESOLVED_PASSWORD_ENV]: undefined }, () => {
    assert.equal(configuredPassword(), null);
  });
});

// ----------------------------------------------------------- route guard ---

/**
 * Every API route must check the session itself.
 *
 * proxy.ts also gates these, but Next's own documentation warns that a matcher
 * edit or a moved route silently removes that coverage — so this asserts the
 * second layer exists. It is a source scan rather than an HTTP test on purpose:
 * it fails the moment someone adds an unguarded route, without a server.
 */
const UNGUARDED_BY_DESIGN = new Set([
  // The platform health check runs before anyone has logged in.
  'app/api/health/route.ts',
  // Gating the way in would leave no way in.
  'app/api/auth/login/route.ts',
  'app/api/auth/logout/route.ts',
]);

function routeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, found);
    else if (entry.name === 'route.ts') found.push(path.relative(process.cwd(), full));
  }
  return found;
}

test('every API route verifies the session, or is listed as deliberately open', () => {
  const routes = routeFiles('app/api');
  assert.ok(routes.length >= 20, `expected to find the API routes, found ${routes.length}`);

  const unguarded = routes.filter((file) => {
    if (UNGUARDED_BY_DESIGN.has(file)) return false;
    return !fs.readFileSync(file, 'utf8').includes('requireSession');
  });
  assert.deepEqual(unguarded, [], `these routes do not check the session: ${unguarded.join(', ')}`);
});

test('every exported handler in a guarded route checks the session', () => {
  const offenders: string[] = [];

  for (const file of routeFiles('app/api')) {
    if (UNGUARDED_BY_DESIGN.has(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    // One requireSession() call is needed per exported HTTP method: importing
    // it and using it in GET only would leave POST wide open.
    const handlers = source.match(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
    const checks = source.match(/requireSession\s*\(/g) ?? [];
    if (checks.length < handlers.length) {
      offenders.push(`${file} (${handlers.length} handlers, ${checks.length} checks)`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('the deliberately-open routes are the ones proxy.ts also excludes', () => {
  const proxySource = fs.readFileSync('proxy.ts', 'utf8');
  const matcher = proxySource.match(/'\/\(\(\?!(.+?)\)\.\*\)'/)?.[1];
  assert.ok(matcher, 'could not find the proxy matcher');

  // If one layer stops excluding a path and the other does not, an endpoint
  // either becomes unreachable or becomes unprotected. Keep them in step.
  for (const fragment of ['api/auth', 'api/health']) {
    assert.ok(matcher.includes(fragment), `proxy matcher no longer excludes ${fragment}`);
  }
});
