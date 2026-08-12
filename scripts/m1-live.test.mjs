import assert from 'node:assert/strict';
import test from 'node:test';

import { runM1Live, validateM1Evidence } from './m1-live.mjs';

const COMPLETE_ENV = {
  STYTCH_PROJECT_ID: 'project-test-configured',
  STYTCH_SECRET: 'stytch-configured',
  STYTCH_PUBLIC_TOKEN: 'public-token-test-configured',
  ANTHROPIC_API_KEY: 'anthropic-configured',
  MODAL_TOKEN_ID: 'modal-id-configured',
  MODAL_TOKEN_SECRET: 'modal-secret-configured',
};

function runResult({
  runId,
  workspaceId,
  providerWorkspaceId,
  commitSha,
  marker,
  eventSequences,
  visibleMarkers = [marker],
}) {
  return {
    runId,
    workspaceId,
    providerWorkspaceId,
    sandboxProvider: 'modal',
    modelProvider: 'anthropic',
    commitSha,
    marker,
    eventSequences,
    visibleMarkers,
    screenshotPath: `/safe/evidence/${marker}.png`,
  };
}

function fakeSession(actions) {
  const results = [
    runResult({
      runId: 'run_01INITIAL0000000000000000',
      workspaceId: 'ws_01INITIAL00000000000000000',
      providerWorkspaceId: 'sb-initial',
      commitSha: 'a'.repeat(40),
      marker: 'm1-initial-fixed',
      eventSequences: [1, 2, 3, 4],
    }),
    runResult({
      runId: 'run_01EDIT000000000000000000000',
      workspaceId: 'ws_01INITIAL00000000000000000',
      providerWorkspaceId: 'sb-initial',
      commitSha: 'b'.repeat(40),
      marker: 'm1-edit-fixed',
      eventSequences: [1, 2, 3],
      visibleMarkers: ['m1-initial-fixed', 'm1-edit-fixed'],
    }),
    runResult({
      runId: 'run_01RESTORE00000000000000000',
      workspaceId: 'ws_01RESTORE0000000000000000',
      providerWorkspaceId: 'sb-replacement',
      commitSha: 'c'.repeat(40),
      marker: 'm1-restore-fixed',
      eventSequences: [1, 2, 3, 4, 5],
      visibleMarkers: ['m1-initial-fixed', 'm1-edit-fixed', 'm1-restore-fixed'],
    }),
  ];
  const requiredMarkers = [
    ['m1-initial-fixed'],
    ['m1-initial-fixed', 'm1-edit-fixed'],
    ['m1-initial-fixed', 'm1-edit-fixed', 'm1-restore-fixed'],
  ];
  return {
    async openLogin() {
      actions.push('ui:open-login');
    },
    async waitForAuthenticated() {
      actions.push('auth:wait');
      return {
        userId: 'usr_01LIVE00000000000000000000',
        organizationId: 'org_01LIVE0000000000000000000',
      };
    },
    async createFromPrompt({ marker }) {
      actions.push(`ui:create:${marker}`);
      return { projectId: 'proj_01LIVE000000000000000000' };
    },
    async sendFollowup({ marker }) {
      actions.push(`ui:followup:${marker}`);
    },
    async waitForRun({ marker, requiredMarkers: observedMarkers }) {
      assert.deepEqual(observedMarkers, requiredMarkers.shift());
      actions.push(`public-api+ui:wait:${marker}`);
      return { ...results.shift(), marker };
    },
    async terminateWorkspace(workspaceId) {
      actions.push(`public-api:terminate:${workspaceId}`);
      return { status: 'terminated' };
    },
    async close() {
      actions.push('browser:close');
    },
  };
}

test('refuses fixture/session bypass flags and missing provider credentials', async () => {
  await assert.rejects(
    runM1Live({ env: COMPLETE_ENV, argv: ['--fixture'], createSession: () => assert.fail() }),
    /does not accept flags.*--fixture/,
  );
  await assert.rejects(
    runM1Live({
      env: { ...COMPLETE_ENV, STYTCH_SECRET: 'replace-me', ANTHROPIC_API_KEY: '' },
      argv: [],
      createSession: () => assert.fail(),
    }),
    (error) => {
      assert.match(error.message, /ANTHROPIC_API_KEY, STYTCH_SECRET/);
      assert.doesNotMatch(error.message, /stytch-configured|modal-secret-configured/);
      return true;
    },
  );
});

test('drives interactive auth, UI prompts, public termination, restore, and redacted evidence', async () => {
  const actions = [];
  const output = [];
  const writes = [];
  const evidence = await runM1Live({
    env: COMPLETE_ENV,
    argv: [],
    createSession: async () => fakeSession(actions),
    output: (line) => output.push(line),
    markerFactory: (phase) => `m1-${phase}-fixed`,
    now: () => new Date('2026-08-12T20:00:00.000Z'),
    writeEvidence: async (path, value) => writes.push([path, value]),
  });

  assert.deepEqual(actions, [
    'ui:open-login',
    'auth:wait',
    'ui:create:m1-initial-fixed',
    'public-api+ui:wait:m1-initial-fixed',
    'ui:followup:m1-edit-fixed',
    'public-api+ui:wait:m1-edit-fixed',
    'public-api:terminate:ws_01INITIAL00000000000000000',
    'ui:followup:m1-restore-fixed',
    'public-api+ui:wait:m1-restore-fixed',
    'browser:close',
  ]);
  assert.equal(output.filter((line) => line.includes('Sign in')).length, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0][0], /\.artifacts\/m1-live\/2026-08-12T20-00-00-000Z\.json$/);
  assert.equal(writes[0][1], evidence);
  assert.notEqual(evidence.runs[0].commitSha, evidence.runs[1].commitSha);
  assert.notEqual(evidence.runs[0].workspaceId, evidence.runs[2].workspaceId);
  const serialized = JSON.stringify(evidence);
  for (const secret of Object.values(COMPLETE_ENV))
    assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /modal.*url|token|secret|credential/iu);
});

test('rejects missing, duplicate, and out-of-order live evidence', () => {
  const valid = {
    version: 1,
    createdAt: '2026-08-12T20:00:00.000Z',
    userId: 'usr_live',
    organizationId: 'org_live',
    projectId: 'proj_live',
    runs: [
      runResult({
        runId: 'run_one',
        workspaceId: 'ws_one',
        providerWorkspaceId: 'sb-one',
        commitSha: 'a'.repeat(40),
        marker: 'initial',
        eventSequences: [1, 2, 3],
      }),
      runResult({
        runId: 'run_two',
        workspaceId: 'ws_one',
        providerWorkspaceId: 'sb-one',
        commitSha: 'b'.repeat(40),
        marker: 'edit',
        eventSequences: [1, 2],
        visibleMarkers: ['initial', 'edit'],
      }),
      runResult({
        runId: 'run_three',
        workspaceId: 'ws_two',
        providerWorkspaceId: 'sb-two',
        commitSha: 'c'.repeat(40),
        marker: 'restore',
        eventSequences: [1, 2, 3],
        visibleMarkers: ['initial', 'edit', 'restore'],
      }),
    ],
    terminatedWorkspaceId: 'ws_one',
  };

  assert.doesNotThrow(() => validateM1Evidence(valid, []));
  assert.throws(() => validateM1Evidence({ ...valid, projectId: '' }, []), /projectId/);
  assert.throws(
    () =>
      validateM1Evidence(
        {
          ...valid,
          runs: [{ ...valid.runs[0], eventSequences: [1, 2, 2] }, ...valid.runs.slice(1)],
        },
        [],
      ),
    /strictly ordered/,
  );
  assert.throws(
    () => validateM1Evidence({ ...valid, runs: [valid.runs[0], valid.runs[0], valid.runs[2]] }, []),
    /distinct commits/,
  );
  assert.throws(
    () =>
      validateM1Evidence(
        {
          ...valid,
          runs: [valid.runs[0], valid.runs[1], { ...valid.runs[2], workspaceId: 'ws_one' }],
        },
        [],
      ),
    /replacement workspace/,
  );
});

test('redacts a failing stage instead of returning provider details', async () => {
  const session = fakeSession([]);
  session.waitForRun = async () => {
    throw new Error(`provider rejected ${COMPLETE_ENV.ANTHROPIC_API_KEY}`);
  };
  await assert.rejects(
    runM1Live({
      env: COMPLETE_ENV,
      argv: [],
      createSession: async () => session,
      markerFactory: (phase) => `m1-${phase}-fixed`,
    }),
    (error) => {
      assert.match(error.message, /initial preview/);
      assert.doesNotMatch(error.message, /anthropic-configured|provider rejected/);
      return true;
    },
  );
});
