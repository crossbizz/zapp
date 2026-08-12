import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runLocal } from './local/supervisor.mjs';

test('wires every local process and readiness edge with seam providers and clean shutdown', async () => {
  const events = [];
  const signals = new EventEmitter();
  const services = [];
  const supervisor = {
    failure: new Promise(() => undefined),
    start(spec) {
      services.push(spec.name);
      events.push(`start:${spec.name}`);
    },
    waitForLine(name) {
      events.push(`line:${name}`);
      return Promise.resolve();
    },
    stopAll() {
      events.push(`stop:${services.toReversed().join(',')}`);
      return Promise.resolve();
    },
  };
  let externalProviderCalls = 0;
  const result = await runLocal({
    config: {
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'development',
        RUN_WORKFLOW_PROFILE: 'm1',
        NEXT_PUBLIC_CONTROL_API_URL: 'http://127.0.0.1:4000',
      },
      redactions: [],
      openBrowser: false,
      ports: [31_001, 31_002, 31_003, 31_004, 31_005],
      imageLock: { modalEnvironment: 'zapp-dev', images: [] },
    },
    supervisor,
    exec: async (command, args) => {
      events.push(`exec:${command}:${args.join(' ')}`);
      return { stdout: args.includes('--version') ? '9.15.0' : '' };
    },
    checkPort: async (port) => {
      events.push(`port:${String(port)}`);
      return true;
    },
    waitForHttp: async (url) => {
      events.push(`http:${url}`);
      if (url.endsWith('/login')) queueMicrotask(() => signals.emit('SIGINT'));
    },
    verifyImages: async () => {
      events.push('image-lock:verified-by-seam');
    },
    openBrowser: async () => {
      externalProviderCalls += 1;
    },
    signals,
  });

  assert.equal(result, 0);
  assert.equal(externalProviderCalls, 0);
  assert.deepEqual(services, [
    'git-service',
    'model-gateway',
    'sandbox-service',
    'agent-runs-worker',
    'verification-worker',
    'control-api',
    'web',
  ]);
  assert.equal(events.includes('line:agent-runs-worker'), true);
  assert.equal(events.includes('line:verification-worker'), true);
  assert.equal(events.filter((event) => event.startsWith('http:')).length, 5);
  assert.equal(
    events.at(-1),
    'stop:web,control-api,verification-worker,agent-runs-worker,sandbox-service,model-gateway,git-service',
  );
});
