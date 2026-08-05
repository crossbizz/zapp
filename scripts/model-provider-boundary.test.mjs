import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { shouldScanProductionFile } from './check-model-provider-boundary.mjs';
import {
  baselineConstantsForTests,
  validateBaseline,
} from './model-provider-boundary/baseline.mjs';

const checkerPath = fileURLToPath(new URL('./check-model-provider-boundary.mjs', import.meta.url));
const fixturesDirectory = fileURLToPath(
  new URL('./fixtures/model-provider-boundary/', import.meta.url),
);
const baselinePath = `${fixturesDirectory}/baseline.json`;
const acceptedBaseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../config/model-provider-boundary-baseline.json', import.meta.url)),
  ),
);

function runFixture(name) {
  const fixtureRoot = `${fixturesDirectory}/${name}`;
  const fixtureBaseline = `${fixtureRoot}/baseline.json`;
  return runRoot(fixtureRoot, existsSync(fixtureBaseline) ? fixtureBaseline : baselinePath);
}

function runRoot(root, baseline = baselinePath) {
  return spawnSync(process.execPath, [checkerPath, '--root', root, '--baseline', baseline], {
    encoding: 'utf8',
  });
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
    /provider-call growth: apps\/desktop\/src\/ipc\/utils\/inherited-provider\.ts .*@ai-sdk\/openai#createOpenAI.*allowed 1, found 2/,
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

test('rejects TypeScript import-equals provider loads', () => {
  const result = runFixture('import-equals');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*import-equals\.ts/);
});

test('rejects module.require provider loads', () => {
  const result = runFixture('module-require');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*module-require\.ts/);
});

test('rejects provider loads through an aliased require', () => {
  const result = runFixture('aliased-require');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*aliased-require\.ts/);
});

test('rejects require calls with a provider target and extra arguments', () => {
  const result = runFixture('require-extra-args');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*require-extra-args\.ts/);
});

test('rejects computed two-argument provider imports', () => {
  const result = runFixture('computed-import');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*computed-import\.ts/);
});

test('fails closed on a nonliteral loader target', () => {
  const result = runFixture('nonliteral-loader');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unresolved-loader/);
});

test('default-denies generateSpeech imported from ai', () => {
  const result = runFixture('generate-speech');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*generate-speech\.ts/);
});

test('default-denies experimental_generateVideo imported from ai', () => {
  const result = runFixture('generate-video');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*generate-video\.ts/);
});

test('detects provider packages imported through an npm manifest alias', () => {
  const result = runFixture('package-alias');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*package-alias\.ts/);
});

test('detects an installed official provider SDK outside the ai-sdk namespace', () => {
  const result = runFixture('official-provider');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*official-provider\.ts/);
});

test('detects an official provider SDK through an npm manifest alias', () => {
  const result = runFixture('official-package-alias');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*official-package-alias\.ts/);
});

test('default-denies ai imported through an npm manifest alias', () => {
  const result = runFixture('ai-package-alias');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*ai-package-alias\.ts/);
});

test('rejects call growth through an assignment alias', () => {
  const result = runFixture('assignment-alias');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /provider-call growth|baseline mismatch/);
});

test('rejects a new consumer of an inherited local provider wrapper', () => {
  const result = runFixture('cross-file-wrapper');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*wrapper-consumer\.ts/);
});

test('treats a provider-backed class extends clause as runtime', () => {
  const result = runFixture('class-extends');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*class-extends\.ts/);
});

test('allows implements, interface heritage, and explicit type-only imports', () => {
  const result = runFixture('type-heritage');

  assert.equal(result.status, 0, result.stderr);
});

test('scans production sources under a workers root', () => {
  const result = runFixture('workers-root');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: workers\/provider-worker\.ts/);
});

test('does not exclude a production directory merely named testing', () => {
  const result = runFixture('testing-production');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*testing\/provider-runtime\.ts/);
});

test('scans an in-repo symlink tracked by Git', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'provider-boundary-symlink-'));
  try {
    const workersDirectory = path.join(temporaryRoot, 'workers');
    mkdirSync(workersDirectory, { recursive: true });
    writeFileSync(
      path.join(temporaryRoot, 'provider-source.fixture'),
      readFileSync(`${fixturesDirectory}/tracked-symlink/provider-source.fixture`, 'utf8'),
    );
    symlinkSync('../provider-source.fixture', path.join(workersDirectory, 'provider-worker.ts'));
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: temporaryRoot }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: temporaryRoot }).status, 0);

    const result = runRoot(temporaryRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /new-provider path: workers\/provider-worker\.ts/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('never reads a tracked production symlink into the excluded Pro tree', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'provider-boundary-pro-symlink-'));
  try {
    const workersDirectory = path.join(temporaryRoot, 'workers');
    const proDirectory = path.join(temporaryRoot, 'apps/desktop/src/pro');
    mkdirSync(workersDirectory, { recursive: true });
    mkdirSync(proDirectory, { recursive: true });
    writeFileSync(
      path.join(proDirectory, 'provider-source.ts'),
      'throw new Error("must not read");\n',
    );
    symlinkSync(
      '../apps/desktop/src/pro/provider-source.ts',
      path.join(workersDirectory, 'provider-worker.ts'),
    );
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: temporaryRoot }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: temporaryRoot }).status, 0);

    const result = runRoot(temporaryRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink targets the excluded Pro tree/);
    assert.doesNotMatch(result.stderr, /must not read/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects a baseline reduction until the baseline shrinks in the same change', () => {
  const result = runFixture('reduction');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /baseline mismatch/);
});

test('validates the accepted baseline schema, commit, and exact path set', () => {
  assert.doesNotThrow(() => validateBaseline(acceptedBaseline, { accepted: true }));

  const wrongSchema = structuredClone(acceptedBaseline);
  wrongSchema.schemaVersion += 1;
  assert.throws(() => validateBaseline(wrongSchema, { accepted: true }), /schemaVersion/);

  const wrongCommit = structuredClone(acceptedBaseline);
  wrongCommit.baselineCommit = '0000000000000000000000000000000000000000';
  assert.throws(
    () => validateBaseline(wrongCommit, { accepted: true }),
    /accepted baseline commit/,
  );

  const wrongPaths = structuredClone(acceptedBaseline);
  delete wrongPaths.files[baselineConstantsForTests.ACCEPTED_PATHS[0]];
  assert.throws(
    () => validateBaseline(wrongPaths, { accepted: true }),
    /exactly these seven paths/,
  );
});

test('excludes tests, type-only imports, and the unvendored Pro tree', () => {
  const result = runFixture('excluded');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    shouldScanProductionFile('apps/desktop/src/pro/main/ipc/handlers/local-agent.ts'),
    false,
  );
  assert.equal(shouldScanProductionFile('workers/testing/provider-runtime.ts'), true);
  assert.equal(shouldScanProductionFile('packages/runtime/__tests__/provider-runtime.ts'), true);
});
