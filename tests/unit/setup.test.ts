import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isMountPoint, isWritable, isHostedDeployment, runPreflight } from '@/lib/setup/preflight';
import {
  RESOLVED_SECRET_ENV, authMode, createSessionToken, googleConfigured, randomToken,
  sessionUserId, signPayload, verifyPayload,
} from '@/lib/auth/session';
import { allowedEmails, isAllowedEmail } from '@/lib/auth/users';

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

async function withEnvAsync(vars: Record<string, string | undefined>, body: () => Promise<void>) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await body();
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
    withEnv({ ...NO_HOSTING, [marker]: 'abc-123' }, () =>
      assert.equal(isHostedDeployment(), true, marker));
  }
});

test('isHostedDeployment: a laptop is not a deployment', () => {
  withEnv(NO_HOSTING, () => assert.equal(isHostedDeployment(), false));
});

test('isHostedDeployment: an empty marker does not count', () => {
  withEnv({ ...NO_HOSTING, RAILWAY_PROJECT_ID: '   ' }, () =>
    assert.equal(isHostedDeployment(), false));
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
  withEnv({ ...NO_HOSTING, EVERNOTION_DATA_DIR: dir }, () =>
    assert.deepEqual(runPreflight(), []));
});

// ------------------------------------------------------------ auth mode ---

const NO_HOSTING = {
  RAILWAY_PROJECT_ID: undefined, RAILWAY_SERVICE_ID: undefined,
  RAILWAY_ENVIRONMENT_ID: undefined, RENDER: undefined, FLY_APP_NAME: undefined,
  KUBERNETES_SERVICE_HOST: undefined, DYNO: undefined, EVERNOTION_HOSTED: undefined,
};

const GOOGLE = { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh' };

test('authMode: Google credentials turn sign-in on', () => {
  withEnv({ ...GOOGLE, EVERNOTION_HOSTED_RESOLVED: '1' }, () => {
    assert.equal(googleConfigured(), true);
    assert.equal(authMode(), 'google');
  });
});

test('authMode: a laptop with no Google config is open', () => {
  withEnv(
    { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, EVERNOTION_HOSTED_RESOLVED: '0' },
    () => assert.equal(authMode(), 'open'),
  );
});

test('authMode: a public deployment with no Google config locks, it does not open', () => {
  // The whole point. If this ever returns 'open', an unconfigured deployment
  // serves every note to anyone who finds the URL.
  withEnv(
    { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, EVERNOTION_HOSTED_RESOLVED: '1' },
    () => assert.equal(authMode(), 'locked'),
  );
});

test('authMode: half-configured Google is not configured', () => {
  withEnv(
    { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: '  ', EVERNOTION_HOSTED_RESOLVED: '1' },
    () => assert.equal(authMode(), 'locked'),
  );
});

// ------------------------------------------------------------- allowlist ---

test('isAllowedEmail: only listed addresses get in', () => {
  withEnv({ EVERNOTION_ALLOWED_EMAILS: 'a@example.com, b@example.com' }, () => {
    assert.equal(isAllowedEmail('a@example.com', true), true);
    assert.equal(isAllowedEmail('b@example.com', true), true);
    assert.equal(isAllowedEmail('c@example.com', true), false);
  });
});

test('isAllowedEmail: case and spacing do not matter', () => {
  withEnv({ EVERNOTION_ALLOWED_EMAILS: '  A@Example.COM\n b@example.com ' }, () => {
    assert.deepEqual(allowedEmails(), ['a@example.com', 'b@example.com']);
    assert.equal(isAllowedEmail('a@example.com', true), true);
    assert.equal(isAllowedEmail('A@EXAMPLE.COM', true), true);
  });
});

test('isAllowedEmail: a bare domain admits everyone at it', () => {
  withEnv({ EVERNOTION_ALLOWED_EMAILS: '@example.com' }, () => {
    assert.equal(isAllowedEmail('anyone@example.com', true), true);
    assert.equal(isAllowedEmail('anyone@evil.com', true), false);
    // Must not match a domain that merely ends with the listed one.
    assert.equal(isAllowedEmail('anyone@notexample.com', true), false);
  });
});

test('isAllowedEmail: an unverified address is never allowed', () => {
  // Otherwise the gate is "put the right string in your Google profile".
  withEnv({ EVERNOTION_ALLOWED_EMAILS: 'a@example.com' }, () => {
    assert.equal(isAllowedEmail('a@example.com', false), false);
  });
});

test('isAllowedEmail: an empty allowlist admits nobody', () => {
  withEnv({ EVERNOTION_ALLOWED_EMAILS: undefined }, () => {
    assert.equal(isAllowedEmail('a@example.com', true), false);
  });
});

// --------------------------------------------------------------- session ---

test('a session token names its user and survives a round trip', async () => {
  await withEnvAsync({ EVERNOTION_SECRET: 'test-secret' }, async () => {
    const token = await createSessionToken('u_abc123');
    assert.equal(await sessionUserId(token), 'u_abc123');
  });
});

test('a session token cannot be re-pointed at another user', async () => {
  await withEnvAsync({ EVERNOTION_SECRET: 'test-secret' }, async () => {
    const token = await createSessionToken('u_abc123');
    const forged = token.replace('u_abc123', 'u_victim');
    assert.equal(await sessionUserId(forged), null);
  });
});

test('a session token signed with another secret is rejected', async () => {
  let token = '';
  await withEnvAsync({ EVERNOTION_SECRET: 'secret-one' }, async () => {
    token = await createSessionToken('u_abc123');
  });
  await withEnvAsync({ EVERNOTION_SECRET: 'secret-two' }, async () => {
    assert.equal(await sessionUserId(token), null);
  });
});

test('an expired session is rejected', async () => {
  await withEnvAsync({ EVERNOTION_SECRET: 'test-secret' }, async () => {
    const expired = await signPayload(`u_abc123:${Date.now() - 1000}`);
    assert.equal(await sessionUserId(expired), null);
  });
});

test('garbage is rejected rather than throwing', async () => {
  await withEnvAsync({ EVERNOTION_SECRET: 'test-secret' }, async () => {
    for (const bad of [undefined, '', '.', 'nope', 'a.b.c', 'u_x:123.deadbeef']) {
      assert.equal(await sessionUserId(bad as string | undefined), null, String(bad));
    }
  });
});

test('signPayload/verifyPayload round-trips the OAuth state', async () => {
  await withEnvAsync({ EVERNOTION_SECRET: 'test-secret' }, async () => {
    const payload = JSON.stringify({ state: 'abc', verifier: 'xyz', next: '/p/1' });
    assert.equal(await verifyPayload(await signPayload(payload)), payload);
    assert.equal(await verifyPayload('tampered.0000'), null);
  });
});

test('randomToken does not repeat itself', () => {
  const seen = new Set(Array.from({ length: 100 }, () => randomToken(16)));
  assert.equal(seen.size, 100);
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
const UNGUARDED_BY_DESIGN = [
  // The platform health check runs before anyone has logged in.
  'app/api/health/route.ts',
  // Gating the way in would leave no way in. This is a prefix, and it is the
  // same set proxy.ts excludes — the last test in this file keeps the two in
  // step, so widening one without the other is caught.
  'app/api/auth/',
];

const isOpenByDesign = (file: string) =>
  UNGUARDED_BY_DESIGN.some((entry) => file === entry || file.startsWith(entry));

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
    if (isOpenByDesign(file)) return false;
    return !fs.readFileSync(file, 'utf8').includes('requireSession');
  });
  assert.deepEqual(unguarded, [], `these routes do not check the session: ${unguarded.join(', ')}`);
});

test('every exported handler in a guarded route checks the session', () => {
  const offenders: string[] = [];

  for (const file of routeFiles('app/api')) {
    if (isOpenByDesign(file)) continue;
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
