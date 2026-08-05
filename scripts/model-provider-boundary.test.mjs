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
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { shouldScanProductionFile } from './check-model-provider-boundary.mjs';
import { analyzeProductionSources } from './model-provider-boundary/analyzer.mjs';
import {
  baselineConstantsForTests,
  inventoryDigest,
  validateBaseline,
} from './model-provider-boundary/baseline.mjs';

const checkerPath = fileURLToPath(new URL('./check-model-provider-boundary.mjs', import.meta.url));
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixturesDirectory = fileURLToPath(
  new URL('./fixtures/model-provider-boundary/', import.meta.url),
);
const baselinePath = `${fixturesDirectory}/baseline.json`;
const acceptedBaseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../config/model-provider-boundary-baseline.json', import.meta.url)),
  ),
);

function runFixture(name, spawnOptions = {}) {
  const fixtureRoot = `${fixturesDirectory}/${name}`;
  const fixtureBaseline = `${fixtureRoot}/baseline.json`;
  return runRoot(
    fixtureRoot,
    existsSync(fixtureBaseline) ? fixtureBaseline : baselinePath,
    spawnOptions,
  );
}

function runRoot(root, baseline = baselinePath, spawnOptions = {}) {
  return spawnSync(process.execPath, [checkerPath, '--root', root, '--baseline', baseline], {
    encoding: 'utf8',
    ...spawnOptions,
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

test('rejects provider loads through a createRequire alias', () => {
  const result = runFixture('create-require');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require\.ts/);
});

test('tracks createRequire from a node:module default-import namespace', () => {
  const result = runFixture('create-require-default-namespace');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-default-namespace\.ts/);
});

test('tracks createRequire from a dynamic module namespace', () => {
  const result = runFixture('create-require-dynamic-namespace');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-dynamic-namespace\.ts/);
});

test('tracks createRequire from a computed dynamic node:module namespace', () => {
  const result = runFixture('create-require-computed-dynamic-namespace');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-computed-dynamic-namespace\.ts/);
});

test('tracks createRequire from a node:module import-equals namespace', () => {
  const result = runFixture('create-require-import-equals-namespace');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-import-equals-namespace\.ts/);
});

test('tracks a concatenated computed createRequire member', () => {
  const result = runFixture('computed-create-require-concat');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*computed-create-require-concat\.ts/);
});

test('tracks a template-computed createRequire member', () => {
  const result = runFixture('computed-create-require-template');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*computed-create-require-template\.ts/);
});

test('fails closed on an unresolved node:module member', () => {
  const result = runFixture('computed-create-require-unresolved');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unresolved-loader/);
});

test('rejects provider loads through assignment destructuring from module', () => {
  const result = runFixture('assignment-destructured-require');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*assignment-destructured-require\.ts/);
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

test('fails closed when one conditional loader target is unresolved', () => {
  const result = runFixture('nonliteral-loader-conditional');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unresolved-loader/);
});

test('tracks a loader passed through a higher-order function', () => {
  const result = runFixture('loader-higher-order');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-higher-order\.ts/);
});

test('tracks a loader transformed through bind', () => {
  const result = runFixture('loader-bind');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-bind\.ts/);
});

test('tracks a loader selected by a comma expression', () => {
  const result = runFixture('loader-comma');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-comma\.ts/);
});

test('allows a harmless non-loader higher-order function', () => {
  const result = runFixture('non-loader-higher-order');

  assert.equal(result.status, 0, result.stderr);
});

test('tracks a loader through a local function alias', () => {
  const result = runFixture('recursive-loader-function-alias');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*recursive-loader-function-alias\.ts/);
});

test('tracks a loader through an object property', () => {
  const result = runFixture('loader-object-property');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-object-property\.ts/);
});

test('tracks a loader through an array element', () => {
  const result = runFixture('loader-array-element');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-array-element\.ts/);
});

test('tracks a loader through object destructuring', () => {
  const result = runFixture('loader-object-destructure');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-object-destructure\.ts/);
});

test('tracks a loader through array destructuring', () => {
  const result = runFixture('loader-array-destructure');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-array-destructure\.ts/);
});

test('tracks a loader selected from nested literal containers', () => {
  const result = runFixture('loader-nested-literal');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-nested-literal\.ts/);
});

test('tracks a loader container through argument and return provenance', () => {
  const result = runFixture('loader-container-identity');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-container-identity\.ts/);
});

test('tracks a loader container consumed inside a function body', () => {
  const result = runFixture('loader-container-consumer');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-container-consumer\.ts/);
});

test('tracks a createRequire container through argument and return provenance', () => {
  const result = runFixture('create-require-container-identity');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-container-identity\.ts/);
});

test('tracks a createRequire container consumed inside a function body', () => {
  const result = runFixture('create-require-container-consumer');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-container-consumer\.ts/);
});

test('tracks a loader returned by a closure', () => {
  const result = runFixture('loader-closure-return');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-closure-return\.ts/);
});

test('tracks a loader-returning closure consumed inside a function body', () => {
  const result = runFixture('loader-closure-consumer');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-closure-consumer\.ts/);
});

test('tracks a createRequire factory returned by a closure', () => {
  const result = runFixture('create-require-closure-return');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-closure-return\.ts/);
});

test('tracks a createRequire-returning closure consumed inside a function body', () => {
  const result = runFixture('create-require-closure-consumer');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-closure-consumer\.ts/);
});

test('tracks nested factory, container, bind, and comma composition', () => {
  const result = runFixture('loader-nested-composition');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-nested-composition\.ts/);
});

test('keeps generic helper provenance isolated by call edge', () => {
  const result = runFixture('loader-mixed-callsite-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-5 tracks nested object-rest declaration provenance', () => {
  const result = runFixture('loader-object-rest-declaration');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-object-rest-declaration\.ts/);
});

test('round-5 tracks nested array-rest declaration provenance', () => {
  const result = runFixture('loader-array-rest-declaration');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-array-rest-declaration\.ts/);
});

test('round-5 tracks object-rest destructuring assignment provenance', () => {
  const result = runFixture('loader-object-rest-assignment');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-object-rest-assignment\.ts/);
});

test('round-5 tracks array-rest destructuring assignment provenance', () => {
  const result = runFixture('loader-array-rest-assignment');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-array-rest-assignment\.ts/);
});

test('round-5 tracks loader provenance through logical OR', () => {
  const result = runFixture('loader-logical-or');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-logical-or\.ts/);
});

test('round-5 tracks loader provenance through logical AND', () => {
  const result = runFixture('loader-logical-and');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-logical-and\.ts/);
});

test('round-5 tracks loader provenance through nullish coalescing', () => {
  const result = runFixture('loader-logical-nullish');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-logical-nullish\.ts/);
});

test('round-5 tracks createRequire through logical forwarding', () => {
  const result = runFixture('create-require-logical');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-logical\.ts/);
});

test('round-5 tracks require.call invocation', () => {
  const result = runFixture('loader-call');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-call\.ts/);
});

test('round-5 tracks require.apply invocation arguments', () => {
  const result = runFixture('loader-apply');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-apply\.ts/);
});

test('round-5 tracks createRequire apply followed by loader call', () => {
  const result = runFixture('create-require-call-apply');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-call-apply\.ts/);
});

test('round-5 tracks class-field and constructor loader provenance', () => {
  const result = runFixture('loader-class-constructor');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-class-constructor\.ts/);
});

test('round-5 tracks loader provenance through Array.map', () => {
  const result = runFixture('loader-array-map');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-array-map\.ts/);
});

test('round-5 tracks loader provenance through filter and find', () => {
  const result = runFixture('loader-array-filter-find');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-array-filter-find\.ts/);
});

test('round-5 tracks loader provenance through Array.reduce', () => {
  const result = runFixture('loader-array-reduce');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-array-reduce\.ts/);
});

test('round-5 tracks loaders through mutated cyclic containers', () => {
  const result = runFixture('loader-mutated-cycle');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*loader-mutated-cycle\.ts/);
});

test('round-5 allows harmless structural binding flows', () => {
  const result = runFixture('structural-binding-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-5 allows unreachable logical loader branches', () => {
  const result = runFixture('loader-logical-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-5 allows harmless call, apply, and class flows', () => {
  const result = runFixture('loader-invocation-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-5 allows harmless callback and cyclic-container flows', () => {
  const result = runFixture('loader-callback-cycle-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-6 tracks loaders through callback array methods and reduce initial values', () => {
  const result = runFixture('loader-callback-methods');

  assert.equal(result.status, 1);
  for (const fileName of ['flat-map', 'some', 'every', 'for-each', 'reduce-initial']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('round-6 allows harmless callback array methods and reduce initial values', () => {
  const result = runFixture('loader-callback-methods-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-6 tracks loader invocation through the Array.reduce callback owner argument', () => {
  const result = runFixture('loader-array-reduce-arguments');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*reduce-arguments\.ts/);
});

test('round-6 allows a harmless Array.reduce callback owner argument', () => {
  const result = runFixture('loader-array-reduce-arguments-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 resolves harmless Array.reduce computed indexes per callback invocation', () => {
  const result = runFixture('loader-array-reduce-computed-index-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 detects require selected by Array.reduce computed callback indexes', () => {
  const result = runFixture('loader-array-reduce-computed-index');

  assert.equal(result.status, 1);
  for (const fileName of [
    'no-initial-require',
    'explicit-initial-require',
    'derived-index-require',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 preserves sparse Array.reduce indexes with leading, internal, and trailing holes', () => {
  const result = runFixture('loader-array-reduce-sparse-index');

  assert.equal(result.status, 1);
  for (const fileName of [
    'sparse-no-initial-positive',
    'sparse-explicit-initial-positive',
    'internal-hole-no-initial-require',
    'trailing-hole-no-initial-require',
    'leading-hole-explicit-initial-require',
    'trailing-hole-explicit-initial-require',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 skips sparse Array.reduce holes without synthesizing compacted indexes', () => {
  const result = runFixture('loader-array-reduce-sparse-index-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-6 tracks loaders through array mutations, spreads, and Object.assign', () => {
  const result = runFixture('loader-container-mutations');

  assert.equal(result.status, 1);
  for (const fileName of ['push', 'unshift', 'array-spread', 'object-assign', 'mutation-cycle']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('round-6 allows harmless cyclic array mutations, spreads, and Object.assign', () => {
  const result = runFixture('loader-container-mutations-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 tracks Object.assign aliases', () => {
  const result = runFixture('loader-object-assign-aliases');

  assert.equal(result.status, 1);
  for (const fileName of ['property-alias', 'destructured-alias']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 allows unrelated assign functions and harmless Object.assign aliases', () => {
  const result = runFixture('loader-object-assign-aliases-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 tracks Object.assign through destructuring assignment targets', () => {
  const result = runFixture('loader-object-assign-aliases');

  assert.equal(result.status, 1);
  for (const fileName of ['shorthand-target', 'renamed-target']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 allows harmless or unrelated destructured assign functions', () => {
  const result = runFixture('loader-object-assign-aliases-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 tracks computed and defaulted Object.assign destructuring aliases', () => {
  const result = runFixture('loader-object-assign-computed-defaulted-aliases');

  assert.equal(result.status, 1);
  for (const fileName of [
    'computed-key-positive',
    'computed-literal-positive',
    'default-target-positive',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 keeps non-assign computed keys and harmless defaults clean', () => {
  const result = runFixture('loader-object-assign-computed-defaulted-aliases-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 selects an Object.assign default when a known source member is undefined', () => {
  const result = runFixture('loader-object-assign-computed-defaulted-aliases');

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /new-provider path: .*undefined-source-selects-assign-default-unsafe\.ts/,
  );
});

test('AR-1 suppresses an Object.assign default when a known source member is defined', () => {
  const result = runFixture('loader-object-assign-computed-defaulted-aliases-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 keeps a missing computed property with a harmless default clean', () => {
  const result = runFixture('loader-object-assign-computed-defaulted-aliases-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 invalidates Object.assign aliases after harmless reassignment', () => {
  const result = runFixture('loader-object-assign-alias-reassignment-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 preserves active, reattached, and conditionally reassigned Object.assign aliases', () => {
  const result = runFixture('loader-object-assign-alias-reassignment');

  assert.equal(result.status, 1);
  for (const fileName of [
    'active-alias-before-reassignment',
    'reattached-alias',
    'detached-source-active-chain',
    'unknown-conditional-reassignment',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 preserves a detached Object.assign alias after source invocation', () => {
  const result = runFixture('loader-object-assign-alias-reassignment');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*detached-alias-survives-source-invocation\.ts/);
});

test('AR-1 keeps detached Object.assign aliases source-order controls clean', () => {
  const result = runFixture('loader-object-assign-alias-reassignment-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-6 tracks push and unshift container identity through aliases and late assignment', () => {
  const result = runFixture('loader-mutated-container-identity');

  assert.equal(result.status, 1);
  for (const fileName of ['alias-push', 'late-push', 'late-unshift']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('round-6 allows harmless aliases and late array assignment mutations', () => {
  const result = runFixture('loader-mutated-container-identity-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 keeps loader positions exact across push and unshift mutations', () => {
  const result = runFixture('loader-mutation-overwrite-semantics');

  assert.equal(result.status, 1);
  for (const fileName of ['push-appended-loader', 'unshift-shifted-loader']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 allows harmless positions after push and unshift mutations', () => {
  const result = runFixture('loader-mutation-overwrite-semantics-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 tracks active and reattached array aliases plus reachable mutations', () => {
  const result = runFixture('loader-alias-mutation-positions');

  assert.equal(result.status, 1);
  for (const fileName of [
    'active-alias-push',
    'active-alias-chain-unshift',
    'alias-unshift',
    'late-alias-unshift',
    'reachable-conditional-unshift',
    'reattached-alias-chain-unshift',
    'unknown-conditional-unshift',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 drops detached array aliases and unreachable mutations', () => {
  const result = runFixture('loader-alias-mutation-positions-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 tracks runtime-reachable mutations on active array identities', () => {
  const result = runFixture('loader-array-alias-reachability');

  assert.equal(result.status, 1);
  for (const fileName of [
    'function-local-active-alias-unsafe',
    'do-while-false-mutation-unsafe',
    'reachable-switch-mutation-unsafe',
    'known-false-detach-unsafe',
    'array-sibling-survives-detach-unsafe',
    'mutation-argument-reattaches-alias-unsafe',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 ignores detached array identities and definitely unreachable mutations', () => {
  const result = runFixture('loader-array-alias-reachability-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 snapshots direct and aliased array mutations at each object spread', () => {
  const result = runFixture('loader-cached-array-spread-mutations');

  assert.equal(result.status, 1);
  for (const fileName of ['direct-unshift-unsafe', 'alias-push-unsafe']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 keeps current and earlier snapshot indexes clean across later array mutations', () => {
  const result = runFixture('loader-cached-array-spread-mutations-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 respects Object.assign source order for final loader values', () => {
  const result = runFixture('loader-object-assign-overwrite-semantics');

  assert.equal(result.status, 1);
  for (const fileName of ['final-loader', 'alias-final-loader']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 allows Object.assign properties overwritten by harmless values', () => {
  const result = runFixture('loader-object-assign-overwrite-semantics-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 tracks final loaders through Object.assign target identity', () => {
  const result = runFixture('loader-object-assign-target-identity');

  assert.equal(result.status, 1);
  for (const fileName of [
    'aliased-object-final-loader',
    'direct-array-final-loader',
    'aliased-array-final-loader',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 keeps Object.assign target identity clean after final harmless writes', () => {
  const result = runFixture('loader-object-assign-target-identity-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 recovers exact Object.assign members after earlier unknown sources', () => {
  const result = runFixture('loader-object-assign-unknown-source-overwrite-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 keeps Object.assign unknown source order conservative', () => {
  const result = runFixture('loader-object-assign-unknown-source-overwrite');

  assert.equal(result.status, 1);
  for (const fileName of [
    'unknown-before-final-require',
    'require-before-unknown',
    'multi-source-final-require',
    'array-index-unknown-before-final-require',
    'array-index-require-before-unknown',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('round-6 tracks static class fields and assignments through aliases of this', () => {
  const result = runFixture('loader-class-aliases');

  assert.equal(result.status, 1);
  for (const fileName of ['static-class-field', 'this-alias']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('round-6 keeps static and instance class fields isolated in harmless alias flows', () => {
  const result = runFixture('loader-class-aliases-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 inspects called instance methods through chained aliases of this', () => {
  const result = runFixture('loader-called-this-aliases');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*called-this-aliases\.ts/);
});

test('AR-1 preserves mutations across successive calls on one class instance', () => {
  const result = runFixture('loader-called-instance-state');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*called-instance-state\.ts/);
});

test('AR-1 isolates called instance state and honors later harmless overwrites', () => {
  const result = runFixture('loader-called-instance-state-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 preserves mutations on the matching factory-created class instance', () => {
  const result = runFixture('loader-factory-created-instance-state');

  assert.equal(result.status, 1);
  for (const fileName of [
    'factory-instance-positive',
    'nested-factory-instance-positive',
    'recursive-factory-instance-positive',
    'map-constructor-second-instance-unsafe',
    'map-factory-second-instance-unsafe',
    'map-mutator-same-instance-unsafe',
    'factory-branch-configured-instance',
    'factory-contextual-loader-if-condition',
    'factory-unknown-branch-conservative',
    'factory-parameterized-loader-instance',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*/${fileName}\\.ts`));
  }
});

// Catches removal of callback/factory invocation identity or branch selection.
test('AR-1 isolates factory-created instances across direct and nested calls', () => {
  const result = runFixture('loader-factory-created-instance-state-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 leaves 250 uncalled this-alias methods bounded and allowed', () => {
  const result = runFixture('loader-called-this-aliases-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-6 normalizes nested Function.prototype call and apply invocations', () => {
  const result = runFixture('loader-nested-invocations');

  assert.equal(result.status, 1);
  for (const fileName of ['call-call', 'apply-call', 'call-apply', 'apply-apply']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('round-6 does not normalize unrelated call and apply methods as loaders', () => {
  const result = runFixture('loader-nested-invocations-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 recursively normalizes nested Function.prototype call and apply invocations', () => {
  const result = runFixture('loader-recursive-intrinsic-invocations');

  assert.equal(result.status, 1);
  for (const fileName of ['nested-call-apply', 'nested-apply-call']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 allows recursively nested intrinsic invocations of harmless targets', () => {
  const result = runFixture('loader-recursive-intrinsic-invocations-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 normalizes every finite intrinsic invocation chain', () => {
  const result = runFixture('loader-intrinsic-depth');

  assert.equal(result.status, 1);
  for (const fileName of ['unsafe-depth-33', 'unsafe-depth-257']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 allows finite intrinsic invocation chains with harmless targets', () => {
  const result = runFixture('loader-intrinsic-depth-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 terminates cyclic intrinsic aliases', () => {
  const result = runFixture('loader-intrinsic-cycle-control', { timeout: 5_000 });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 tracks aliased Function.prototype call and apply invocations', () => {
  const result = runFixture('loader-intrinsic-invocation-aliases');

  assert.equal(result.status, 1);
  for (const fileName of [
    'property-call-alias',
    'property-apply-alias',
    'destructured-call-alias',
    'destructured-apply-alias',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 allows unrelated and shadowed intrinsic invocation aliases', () => {
  const result = runFixture('loader-intrinsic-invocation-aliases-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-6 tracks nested assigned literals through cyclic rest and default destructuring', () => {
  const result = runFixture('loader-cyclic-nested-destructuring');

  assert.equal(result.status, 1);
  for (const fileName of ['object-rest-default', 'array-rest-default']) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('round-6 allows harmless cyclic nested rest and default destructuring', () => {
  const result = runFixture('loader-cyclic-nested-destructuring-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 selects loader defaults for absent object properties and array elements', () => {
  const result = runFixture('loader-reachable-destructuring-defaults');

  assert.equal(result.status, 1);
  for (const fileName of [
    'object-binding-declaration',
    'array-binding-declaration',
    'object-destructuring-assignment',
    'array-destructuring-assignment',
    'object-present-undefined',
    'array-present-undefined',
    'object-unknown-presence',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 ignores loader defaults behind known-present object properties and array elements', () => {
  const result = runFixture('loader-unreachable-destructuring-defaults-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 keeps uncertain and final loader object spread values', () => {
  const result = runFixture('loader-unknown-object-spread-default');

  assert.equal(result.status, 1);
  for (const fileName of [
    'unknown-spread-after-defined',
    'mutated-known-spread',
    'known-undefined-spread',
    'known-loader-overwrite-positive',
    'mutated-loader-positive',
    'undefined-overwrite-with-loader-default-positive',
    'unknown-before-final-loader-positive',
    'unknown-last-keeps-loader-positive',
  ]) {
    assert.match(result.stderr, new RegExp(`new-provider path: .*${fileName}\\.ts`));
  }
});

test('AR-1 honors object spread overwrites and harmless defaults', () => {
  const result = runFixture('loader-unknown-object-spread-default-control');

  assert.equal(result.status, 0, result.stderr);
});

test('AR-1 keeps object-spread shape analysis bounded', async () => {
  const lines = [
    'export {};',
    'const marker = require;',
    "const provider = '@example/not-forbidden';",
  ];
  for (let index = 0; index < 500; index += 1) {
    lines.push(`const base${index} = { load: console.log };`);
    lines.push(`const out${index} = { ...base${index} };`);
    lines.push(`out${index}.load(provider);`);
  }

  const startedAt = performance.now();
  const inventory = await analyzeProductionSources(
    projectRoot,
    [
      {
        relativePath: 'apps/desktop/src/ipc/utils/spread-performance.ts',
        text: lines.join('\n'),
      },
    ],
    { modules: new Map([['ai', 'ai']]), packageImports: [] },
  );
  const elapsedMs = performance.now() - startedAt;

  assert.deepEqual(inventory, {});
  assert.ok(elapsedMs < 6_000, `object-spread analysis took ${elapsedMs.toFixed(0)}ms`);
});

test('round-5 keeps mixed callsites isolated in reverse order', () => {
  const result = runFixture('loader-mixed-callsite-reverse-control');

  assert.equal(result.status, 0, result.stderr);
});

test('round-5 keeps mixed callsites isolated across branches', () => {
  const result = runFixture('loader-mixed-branch-control');

  assert.equal(result.status, 0, result.stderr);
});

test('tracks a createRequire factory through argument and return provenance', () => {
  const result = runFixture('create-require-identity');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-identity\.ts/);
});

test('tracks a createRequire factory transformed through bind', () => {
  const result = runFixture('create-require-bind');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-bind\.ts/);
});

test('tracks a createRequire factory selected by a comma expression', () => {
  const result = runFixture('create-require-comma');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*create-require-comma\.ts/);
});

test('tracks factory and loader assignments through a property', () => {
  const result = runFixture('callable-assignment-property');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*callable-assignment-property\.ts/);
});

test('allows harmless callback aliases, properties, and array elements', () => {
  const result = runFixture('non-loader-callable-controls');

  assert.equal(result.status, 0, result.stderr);
});

test('allows recursive provenance rooted in a shadowed require', () => {
  const result = runFixture('shadowed-require-control');

  assert.equal(result.status, 0, result.stderr);
});

test('allows computed createRequire access on an unrelated module', () => {
  const result = runFixture('unrelated-module-create-require-control');

  assert.equal(result.status, 0, result.stderr);
});

test('default-denies generateSpeech imported from ai', () => {
  const result = runFixture('generate-speech');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*generate-speech\.ts/);
});

test('default-denies an unused runtime provider import', () => {
  const result = runFixture('unused-runtime-import');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*unused-runtime-import\.ts/);
});

test('allows an unused type-only provider import', () => {
  const result = runFixture('unused-type-only-import');

  assert.equal(result.status, 0, result.stderr);
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

test('default-denies providers imported through a package imports-map alias', () => {
  const result = runFixture('package-imports-alias');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*package-imports-alias\.ts/);
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

test('rejects a new CommonJS consumer of an inherited local provider wrapper', () => {
  const result = runFixture('local-require-wrapper');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*wrapper-consumer\.ts/);
});

test('rejects a new dynamic-import consumer of an inherited local provider wrapper', () => {
  const result = runFixture('local-dynamic-import-wrapper');

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

test('scans test-looking modules that are reachable from a production root', () => {
  const result = runFixture('reachable-test-looking');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /new-provider path: .*provider\.test\.ts/);
  assert.match(result.stderr, /new-provider path: .*provider\.spec\.ts/);
  assert.match(result.stderr, /new-provider path: .*__tests__\/provider-wrapper\.ts/);
});

test('does not make a test-looking module runtime-reachable through a type-only edge', () => {
  const result = runFixture('type-only-reachability');

  assert.equal(result.status, 0, result.stderr);
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

test('rejects a reversible reduction against the immutable anchor inventory', () => {
  const result = runFixture('reduction');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /baseline mismatch/);
});

test('validates the accepted baseline schema, commit, and exact path set', () => {
  assert.doesNotThrow(() => validateBaseline(acceptedBaseline, { accepted: true }));

  assert.equal(baselineConstantsForTests.ACCEPTED_PATHS.length, 9);
  assert.deepEqual(acceptedBaseline.files['apps/desktop/src/ipc/utils/stream_text_utils.ts'], {
    providerCalls: { 'call:ai#Output': 1 },
    providerImports: { 'import:ai#Output': 1 },
    providerUses: { 'use:ai#Output': 2 },
  });
  assert.deepEqual(acceptedBaseline.files['apps/desktop/src/ipc/utils/provider_options.ts'], {
    providerCalls: {},
    providerImports: {
      'import:@ai-sdk/google#GoogleGenerativeAIProviderOptions': 1,
      'import:@ai-sdk/openai#OpenAIResponsesProviderOptions': 1,
    },
    providerUses: {},
  });

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
  wrongPaths.files = Object.fromEntries(
    Object.entries(wrongPaths.files).filter(
      ([relativePath]) => relativePath !== baselineConstantsForTests.ACCEPTED_PATHS[0],
    ),
  );
  assert.throws(() => validateBaseline(wrongPaths, { accepted: true }), /exactly these nine paths/);

  const casuallyBlessedGrowth = structuredClone(acceptedBaseline);
  casuallyBlessedGrowth.files['apps/desktop/src/ipc/utils/stream_text_utils.ts'].providerCalls[
    'call:ai#Output'
  ] += 1;
  casuallyBlessedGrowth.inventorySha256 = inventoryDigest(casuallyBlessedGrowth.files);
  assert.throws(
    () => validateBaseline(casuallyBlessedGrowth, { accepted: true }),
    /inventory digest.*migrate the anchor and ADR/,
  );
});

test('derives the accepted inventory from its declared Git anchor', async () => {
  const checkerModule = await import('./check-model-provider-boundary.mjs');

  assert.equal(typeof checkerModule.scanRepositoryAtCommit, 'function');
  const anchorInventory = await checkerModule.scanRepositoryAtCommit(
    projectRoot,
    acceptedBaseline.baselineCommit,
  );
  assert.deepEqual(anchorInventory, acceptedBaseline.files);
});

test('validates the accepted ADR decision content and binds it to the baseline', async () => {
  const adrPath = path.join(projectRoot, 'docs/adr/0005-desktop-provider-migration-window.md');
  assert.equal(existsSync(adrPath), true, 'ADR-0005 must be present in the checked-out branch');

  const baselineModule = await import('./model-provider-boundary/baseline.mjs');
  assert.equal(typeof baselineModule.validateAcceptedAdr, 'function');
  const adrText = readFileSync(adrPath, 'utf8');
  assert.doesNotThrow(() => baselineModule.validateAcceptedAdr(adrText, acceptedBaseline));

  const weakenedDecision = adrText.replace(
    'exception ends when MAC-6 lands and never extends to new call sites',
    'exception ends when MAC-6 lands and may extend to new call sites',
  );
  assert.throws(
    () => baselineModule.validateAcceptedAdr(weakenedDecision, acceptedBaseline),
    /ADR-0005|digest|decision/,
  );
});

test('discovers test-looking candidates while excluding type-only uses and the Pro tree', () => {
  const result = runFixture('excluded');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    shouldScanProductionFile('apps/desktop/src/pro/main/ipc/handlers/local-agent.ts'),
    false,
  );
  assert.equal(shouldScanProductionFile('workers/testing/provider-runtime.ts'), true);
  assert.equal(shouldScanProductionFile('packages/runtime/__tests__/provider-runtime.ts'), true);
});
