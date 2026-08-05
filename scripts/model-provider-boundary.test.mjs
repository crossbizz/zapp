import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { shouldScanProductionFile } from './check-model-provider-boundary.mjs';

const checkerPath = fileURLToPath(new URL('./check-model-provider-boundary.mjs', import.meta.url));
const fixturesDirectory = fileURLToPath(
  new URL('./fixtures/model-provider-boundary/', import.meta.url),
);
const baselinePath = `${fixturesDirectory}/baseline.json`;

function runFixture(name) {
  return spawnSync(
    process.execPath,
    [checkerPath, '--root', `${fixturesDirectory}/${name}`, '--baseline', baselinePath],
    { encoding: 'utf8' },
  );
}

test('rejects a provider call from a new production path', () => {
  const result = runFixture('new-path');

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /new-provider path: apps\/desktop\/src\/ipc\/utils\/new-provider\.ts/,
  );
});

test('accepts the inherited provider baseline', () => {
  const result = runFixture('inherited');

  assert.equal(result.status, 0, result.stderr);
});

test('rejects an extra provider call in an allowlisted production path', () => {
  const result = runFixture('extra-call');

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /provider-call growth: apps\/desktop\/src\/ipc\/utils\/inherited-provider\.ts .*@ai-sdk\/openai#createOpenAI.*allowed 1, found 2/,
  );
});

test('rejects a new provider call hidden behind a local alias', () => {
  const result = runFixture('aliased-call');

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /provider-use growth: apps\/desktop\/src\/ipc\/utils\/inherited-provider\.ts .*@ai-sdk\/openai#createOpenAI.*allowed 1, found 2/,
  );
});

test('rejects call growth when an alias replaces the inherited direct call', () => {
  const result = runFixture('replaced-with-alias');

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /provider-call growth: apps\/desktop\/src\/ipc\/utils\/inherited-provider\.ts .*@ai-sdk\/openai#createOpenAI.*allowed 1, found 2/,
  );
});

test('rejects dynamically loaded completion APIs in production', () => {
  const result = runFixture('dynamic-completion');

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /new-provider path: apps\/desktop\/src\/ipc\/utils\/dynamic-completion\.ts/,
  );
});

test('rejects named completion re-exports from ai in production', () => {
  const result = runFixture('named-completion-reexport');

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /new-provider path: apps\/desktop\/src\/ipc\/utils\/named-completion-reexport\.ts/,
  );
});

test('rejects star re-exports from ai in production', () => {
  const result = runFixture('star-completion-reexport');

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /new-provider path: apps\/desktop\/src\/ipc\/utils\/star-completion-reexport\.ts/,
  );
});

test('allows type-only re-exports from ai', () => {
  const result = runFixture('type-only-reexport');

  assert.equal(result.status, 0, result.stderr);
});

test('excludes tests, type-only imports, and the unvendored Pro tree', () => {
  const result = runFixture('excluded');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    shouldScanProductionFile('apps/desktop/src/pro/main/ipc/handlers/local-agent.ts'),
    false,
  );
});
