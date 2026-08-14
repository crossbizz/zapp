import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadLocalConfig, LocalPreflightError } from './local/config.mjs';
import { createProcessSupervisor } from './local/process.mjs';
import { defaultWaitForHttp, runLocal } from './local/supervisor.mjs';

const COMPLETE_ENV = {
  STYTCH_PROJECT_ID: 'project-test-configured',
  STYTCH_SECRET: 'stytch-configured',
  STYTCH_PUBLIC_TOKEN: 'public-token-test-configured',
  ANTHROPIC_API_KEY: 'anthropic-configured',
  MODAL_TOKEN_ID: 'modal-id-configured',
  MODAL_TOKEN_SECRET: 'modal-secret-configured',
  SESSION_JWT_SECRET: 'a'.repeat(64),
};

const LOCAL_FORGEJO_ENV = {
  FORGEJO_URL: 'http://127.0.0.1:3300',
  FORGEJO_ADMIN_TOKEN: 'generated-local-forgejo-token',
};

function localDatabaseUrl() {
  const url = new URL('postgres://127.0.0.1:5432/zapp');
  url.username = 'zapp';
  url.password = 'zapp';
  return url.toString();
}

const LOCK = {
  version: 1,
  environments: {
    dev: {
      modalEnvironment: 'zapp-dev',
      sourceRevision: 'a'.repeat(40),
      tag: '2026-08-12-aaaaaaa',
      images: {
        'forge-node-base': {
          appName: 'zapp-workspaces',
          digest: 'im-base',
          publishedName: 'forge-node-base:2026-08-12-aaaaaaa',
        },
        'forge-web-test': {
          appName: 'zapp-browser-verify',
          digest: 'im-web',
          publishedName: 'forge-web-test:2026-08-12-aaaaaaa',
        },
      },
    },
  },
};

async function configFixture(env = COMPLETE_ENV, argv = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'zapp-local-config-'));
  await writeFile(
    join(cwd, '.env'),
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.15.0' }));
  await writeFile(join(cwd, 'infra.json'), JSON.stringify(LOCK));
  await writeFile(
    join(cwd, '.env.local.forgejo'),
    Object.entries(LOCAL_FORGEJO_ENV)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  return loadLocalConfig({
    cwd,
    env: {},
    argv,
    envPath: join(cwd, '.env'),
    packagePath: join(cwd, 'package.json'),
    imageLockPath: join(cwd, 'infra.json'),
  });
}

test('loads the explicit M1 environment, immutable images, ports, and --no-open', async () => {
  const config = await configFixture(COMPLETE_ENV, ['--no-open']);

  assert.equal(config.openBrowser, false);
  assert.equal(config.env.RUN_WORKFLOW_PROFILE, 'm1');
  assert.equal(config.env.APP_BASE_URL, 'http://127.0.0.1:3000');
  assert.equal(config.env.API_BASE_URL, 'http://127.0.0.1:4000');
  assert.equal(config.env.NEXT_PUBLIC_CONTROL_API_URL, 'http://127.0.0.1:4000');
  assert.equal(config.env.CONTROL_API_INTERNAL_URL, 'http://127.0.0.1:4000');
  assert.equal(config.env.MODEL_GATEWAY_URL, 'http://127.0.0.1:4100');
  assert.equal(config.env.SANDBOX_SERVICE_URL, 'http://127.0.0.1:4400');
  assert.equal(config.env.GIT_SERVICE_URL, 'http://127.0.0.1:4500');
  assert.equal(config.env.SANDBOX_GLOBAL_LIMIT, '100');
  assert.equal(config.env.SANDBOX_OWNER_ID, 'sandbox-local');
  assert.equal(config.env.SERVICE_TOKEN_ISSUER, 'zapp-control-plane');
  assert.equal(config.env.ARTIFACT_REGION, 'us-east-1');
  assert.equal(config.env.PREVIEW_BASE_DOMAIN, 'preview.localhost:4000');
  assert.deepEqual(config.ports, [3000, 4000, 4100, 4400, 4500]);
  assert.equal(config.imageLock.modalEnvironment, 'zapp-dev');
  assert.equal(config.imageLock.images.length, 2);
});

test('pins the Docker Postgres endpoint instead of inheriting a remote database', async () => {
  const config = await configFixture({
    ...COMPLETE_ENV,
    DATABASE_URL: 'postgres://remote.example/zapp',
  });

  assert.equal(config.env.DATABASE_URL, localDatabaseUrl());
});

test('derives stable, separate local keys for an older environment file', async () => {
  const env = {
    ...COMPLETE_ENV,
    SESSION_JWT_SECRET: 'a'.repeat(64),
  };

  const first = await configFixture(env);
  const second = await configFixture(env);

  assert.match(first.env.RUN_INTENT_HMAC_SECRET, /^[0-9a-f]{64}$/u);
  assert.match(first.env.PREVIEW_SHARE_SIGNING_KEY, /^[0-9a-f]{64}$/u);
  assert.equal(first.env.RUN_INTENT_HMAC_SECRET, second.env.RUN_INTENT_HMAC_SECRET);
  assert.equal(first.env.PREVIEW_SHARE_SIGNING_KEY, second.env.PREVIEW_SHARE_SIGNING_KEY);
  assert.notEqual(first.env.RUN_INTENT_HMAC_SECRET, first.env.PREVIEW_SHARE_SIGNING_KEY);
});

test('classifies missing and placeholder provider credentials without printing values', async () => {
  const env = {
    ...COMPLETE_ENV,
    STYTCH_SECRET: 'replace-me-private-value',
    ANTHROPIC_API_KEY: '',
    MODAL_TOKEN_ID: 'replace-me',
  };

  await assert.rejects(configFixture(env), (error) => {
    assert.ok(error instanceof LocalPreflightError);
    assert.deepEqual(error.variables, ['ANTHROPIC_API_KEY', 'MODAL_TOKEN_ID', 'STYTCH_SECRET']);
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
});

test('rejects a mutable or wrongly scoped Modal image lock', async () => {
  const config = await configFixture();
  const cwd = config.cwd;
  await writeFile(
    join(cwd, 'infra.json'),
    JSON.stringify({
      ...LOCK,
      environments: {
        dev: {
          ...LOCK.environments.dev,
          modalEnvironment: 'production',
          images: {
            ...LOCK.environments.dev.images,
            'forge-node-base': {
              ...LOCK.environments.dev.images['forge-node-base'],
              publishedName: 'forge-node-base:latest',
            },
          },
        },
      },
    }),
  );

  assert.throws(
    () =>
      loadLocalConfig({
        cwd,
        env: {},
        argv: [],
        envPath: join(cwd, '.env'),
        packagePath: join(cwd, 'package.json'),
        imageLockPath: join(cwd, 'infra.json'),
      }),
    /zapp-dev|immutable/,
  );
});

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

test('prefixes, redacts, bounds logs and stops process groups in reverse order', async () => {
  const children = [];
  const kills = [];
  const output = [];
  const supervisor = createProcessSupervisor({
    spawnImpl() {
      const child = new FakeChild(100 + children.length);
      children.push(child);
      return child;
    },
    killImpl(pid, signal) {
      kills.push([pid, signal]);
      const child = children.find((candidate) => candidate.pid === Math.abs(pid));
      queueMicrotask(() => child?.emit('exit', 0, signal));
    },
    output: (line) => output.push(line),
    redactions: ['secret-value'],
    maxTailLines: 2,
  });
  supervisor.start({ name: 'first', command: 'one', args: [], env: {}, required: true });
  supervisor.start({ name: 'second', command: 'two', args: [], env: {}, required: true });
  children[0].stdout.emit('data', Buffer.from('one\ntwo secret-value\nthree\n'));

  assert.equal(
    output.some((line) => line === '[first] two [REDACTED]'),
    true,
  );
  assert.deepEqual(supervisor.tail('first'), ['two [REDACTED]', 'three']);
  await supervisor.stopAll();
  assert.deepEqual(kills, [
    [-101, 'SIGTERM'],
    [-100, 'SIGTERM'],
  ]);
});

test('returns the first matching child line for dynamic local endpoints', async () => {
  let child;
  const supervisor = createProcessSupervisor({
    spawnImpl() {
      child = new FakeChild(150);
      return child;
    },
    killImpl() {
      queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
    },
  });
  supervisor.start({
    name: 'forgejo-tunnel',
    command: 'cloudflared',
    args: [],
    env: {},
    required: true,
  });
  const pending = supervisor.waitForLineMatch(
    'forgejo-tunnel',
    /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/u,
  );
  child.stderr.emit(
    'data',
    Buffer.from('2026-08-14 INF + https://local-m1.trycloudflare.com\n'),
  );

  const match = await pending;

  assert.equal(match[0], 'https://local-m1.trycloudflare.com');
  await supervisor.stopAll();
});

test('propagates a child spawn error without hanging shutdown', async () => {
  let child;
  const supervisor = createProcessSupervisor({
    spawnImpl() {
      child = new FakeChild(undefined);
      return child;
    },
  });
  supervisor.start({ name: 'broken', command: 'missing', args: [], env: {}, required: true });
  const spawnError = Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' });
  child.emit('error', spawnError);

  await assert.rejects(supervisor.failure, /broken failed to start: spawn missing ENOENT/);
  await supervisor.stopAll();
});

test('propagates a required child crash and never calls a Docker teardown', async () => {
  const config = await configFixture();
  const calls = [];
  const started = [];
  const stopOrder = [];
  let rejectFailure;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  const supervisor = {
    failure,
    start(spec) {
      started.push(spec);
      if (spec.name === 'sandbox-service') {
        queueMicrotask(() => rejectFailure(new Error('sandbox-service exited with code 7')));
      }
    },
    waitForLine: () => Promise.resolve(),
    waitForLineMatch: () =>
      Promise.resolve([
        'https://local-m1.trycloudflare.com',
        'local-m1.trycloudflare.com',
      ]),
    stopAll: () => {
      stopOrder.push('stop');
      return Promise.resolve();
    },
  };

  await assert.rejects(
    runLocal({
      config,
      supervisor,
      exec: (command, args) => {
        calls.push([command, ...args]);
        return Promise.resolve({ stdout: args.includes('--version') ? '9.15.0' : '' });
      },
      checkPort: () => Promise.resolve(true),
      waitForHttp: () => Promise.resolve(),
      verifyImages: () => Promise.resolve(),
      openBrowser: () => Promise.resolve(),
      signals: new EventEmitter(),
    }),
    /sandbox-service exited with code 7/,
  );

  assert.equal(
    calls.some((call) => call.includes('down')),
    false,
  );
  assert.equal(
    calls.some((call) => call.includes('-v')),
    false,
  );
  assert.equal(
    calls.some((call) => call.includes('modal:publish')),
    false,
  );
  assert.equal(
    calls.some((call) => call.includes('build') && call[0] === 'docker'),
    false,
  );
  assert.deepEqual(stopOrder, ['stop']);
  assert.equal(
    started.find((spec) => spec.name === 'web').env.NEXT_PUBLIC_CONTROL_API_URL,
    'http://127.0.0.1:4000',
  );
  assert.equal(started.find((spec) => spec.name === 'web').env.WATCHPACK_POLLING, 'true');
});

test('reports the exact occupied application port before starting infrastructure', async () => {
  const config = await configFixture();
  const calls = [];
  await assert.rejects(
    runLocal({
      config,
      supervisor: {
        failure: new Promise(() => undefined),
        start: () => assert.fail('a child must not start after a port conflict'),
        stopAll: () => Promise.resolve(),
      },
      exec: (command, args) => {
        calls.push([command, ...args]);
        return Promise.resolve({ stdout: args.includes('--version') ? '9.15.0' : '' });
      },
      checkPort: (port) => Promise.resolve(port !== 4100),
      signals: new EventEmitter(),
    }),
    /port 4100 is already in use/,
  );
  assert.equal(
    calls.some((call) => call.includes('scripts/dev-up.sh')),
    false,
  );
});

test('aborts an in-flight HTTP readiness retry on shutdown', async () => {
  const controller = new AbortController();
  let attempts = 0;

  const readiness = defaultWaitForHttp('http://127.0.0.1:65535/healthz', {
    signal: controller.signal,
    fetchImpl: () => {
      attempts += 1;
      controller.abort();
      return Promise.reject(new Error('service is still starting'));
    },
    wait: () => assert.fail('an aborted readiness check must not schedule another retry'),
  });

  await assert.rejects(readiness, (error) => error.name === 'AbortError');
  assert.equal(attempts, 1);
});

test('runs preflight and startup in dependency order, opens the UI, and exits zero on Ctrl-C', async () => {
  const config = await configFixture();
  const events = [];
  const started = [];
  const signals = new EventEmitter();
  let resolveFailure;
  const failure = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  const supervisor = {
    failure,
    start(spec) {
      started.push(spec);
      events.push(`start:${spec.name}`);
    },
    waitForLine(name) {
      events.push(`ready:${name}`);
      return Promise.resolve();
    },
    waitForLineMatch(name) {
      events.push(`endpoint:${name}`);
      return Promise.resolve([
        'https://local-m1.trycloudflare.com',
        'local-m1.trycloudflare.com',
      ]);
    },
    stopAll() {
      events.push('stop');
      resolveFailure();
      return Promise.resolve();
    },
  };
  const result = await runLocal({
    config,
    supervisor,
    exec: (command, args) => {
      events.push(`exec:${command}:${args.join(' ')}`);
      return Promise.resolve({ stdout: args.includes('--version') ? '9.15.0' : '' });
    },
    checkPort: (port) => {
      events.push(`port:${port}`);
      return Promise.resolve(true);
    },
    waitForHttp: (url) => {
      assert.doesNotMatch(url, /trycloudflare\.com/u);
      events.push(`ready:${url}`);
      return Promise.resolve();
    },
    verifyImages: () => {
      events.push('images');
      return Promise.resolve();
    },
    openBrowser: (url) => {
      events.push(`open:${url}`);
      queueMicrotask(() => signals.emit('SIGINT'));
      return Promise.resolve();
    },
    signals,
  });

  assert.equal(result, 0);
  for (const expected of [
    'exec:npx:-y pnpm@9.15.0 --version',
    'exec:docker:--version',
    'exec:docker:compose version',
    'exec:docker:info',
    'exec:cloudflared:--version',
    'exec:npx:-y pnpm@9.15.0 exec bash scripts/dev-up.sh',
    'exec:npx:-y pnpm@9.15.0 db:migrate',
    'exec:npx:-y pnpm@9.15.0 turbo run build --filter=!@zapp/desktop',
  ]) {
    assert.equal(events.includes(expected), true, expected);
  }
  assert.deepEqual(
    events.filter((event) => event.startsWith('start:')),
    [
      'start:forgejo-tunnel',
      'start:git-service',
      'start:model-gateway',
      'start:sandbox-service',
      'start:agent-runs-worker',
      'start:verification-worker',
      'start:control-api',
      'start:web',
    ],
  );
  assert.equal(events.includes('open:http://127.0.0.1:3000'), true);
  assert.equal(events.includes('ready:forgejo-tunnel'), true);
  assert.equal(
    started.find((spec) => spec.name === 'git-service').env.FORGEJO_ADMIN_TOKEN,
    LOCAL_FORGEJO_ENV.FORGEJO_ADMIN_TOKEN,
  );
  assert.equal(
    started.find((spec) => spec.name === 'git-service').env.GIT_CLONE_BASE_URL,
    'https://local-m1.trycloudflare.com',
  );
  assert.equal(
    started.find((spec) => spec.name === 'sandbox-service').env.GIT_CLONE_BASE_URL,
    'https://local-m1.trycloudflare.com',
  );
  assert.equal(events.at(-1), 'stop');
});
