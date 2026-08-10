import { newId } from '@zapp/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  BrowserPrimitiveObservationSchema,
  type BrowserAgentDriver,
  type BrowserPrimitiveObservation,
} from '../src/browser-agent/driver.js';
import {
  BROWSER_AGENT_FLOW_BUDGET_MS,
  BROWSER_AGENT_TOOL_NAMES,
  browserAgentCompletionId,
  runBrowserAgentFlow,
  runBrowserAgentSession,
  type BrowserAgentEvidenceSink,
  type BrowserAgentGateway,
  type BrowserAgentSessionDependencies,
  type BrowserAgentSessionInput,
} from '../src/browser-agent/session.js';

function observation(
  source: BrowserPrimitiveObservation['source'],
  label: string,
  modelValue: BrowserPrimitiveObservation['modelValue'],
  attachment?: BrowserPrimitiveObservation['attachment'],
): BrowserPrimitiveObservation {
  return BrowserPrimitiveObservationSchema.parse({ source, label, modelValue, attachment });
}

type FakeBrowserAgentDriver = BrowserAgentDriver & {
  readonly resetFlowState: ReturnType<typeof vi.fn>;
  readonly cancelPending: ReturnType<typeof vi.fn>;
};

function driver(calls: string[]): FakeBrowserAgentDriver {
  return {
    resetFlowState: vi.fn(),
    cancelPending: vi.fn(),
    snapshotAccessibilityTree: vi.fn(() =>
      Promise.resolve(observation('accessibility', 'tree', { snapshot: '- heading "Profile"' })),
    ),
    listInteractive: vi.fn(() => {
      calls.push('listInteractive');
      return Promise.resolve(
        observation('dom', 'interactive', {
          elements: [
            { ref: 'element_1', tag: 'button', role: 'button', name: 'Save', disabled: false },
          ],
        }),
      );
    }),
    click: vi.fn((ref: string) => {
      calls.push(`click:${ref}`);
      return Promise.resolve(
        observation('dom', 'click', {
          ref: 'element_1',
          clicked: true,
          url: 'https://preview.example.test/profile',
        }),
      );
    }),
    fill: vi.fn((ref: string) =>
      Promise.resolve(observation('dom', 'fill', { ref, filled: true })),
    ),
    expectVisibleText: vi.fn((text: string) =>
      Promise.resolve(observation('dom', 'visible', { text, visible: true, matchCount: 1 })),
    ),
    readConsole: vi.fn(() => Promise.resolve(observation('console', 'console', { entries: [] }))),
    readFailedRequests: vi.fn(() =>
      Promise.resolve(observation('network', 'network', { requests: [] })),
    ),
    screenshot: vi.fn((label: string) =>
      Promise.resolve(
        observation(
          'screenshot',
          label,
          { label },
          { contentType: 'image/png', body: new Uint8Array([137, 80, 78, 71]) },
        ),
      ),
    ),
  };
}

function sessionDependencies(
  gateway: BrowserAgentGateway,
  evidenceSink: BrowserAgentEvidenceSink,
  createDriver: () => BrowserAgentDriver = () => driver([]),
): BrowserAgentSessionDependencies {
  return {
    gateway,
    evidence: evidenceSink,
    redact: (value) => value,
    countRequestTokens: () => 64,
    createFlowDriver: () => ({ driver: createDriver(), dispose: vi.fn() }),
  };
}

function input(): BrowserAgentSessionInput {
  return {
    organizationId: newId('org'),
    projectId: newId('proj'),
    runId: newId('run'),
    taskId: newId('task'),
    flows: [
      {
        flow: 'update profile',
        journey: ['Open the profile form', 'Save a new display name', 'Observe confirmation'],
      },
    ],
  };
}

function firstFlow(value: BrowserAgentSessionInput): BrowserAgentSessionInput['flows'][number] {
  const flow = value.flows.at(0);
  if (flow === undefined) throw new Error('Test input must contain one flow');
  return flow;
}

function evidence(ids: string[]): BrowserAgentEvidenceSink {
  return {
    record(value) {
      const evidenceArtifactId = newId('art');
      ids.push(evidenceArtifactId);
      expect(value.flow).toBe('update profile');
      return Promise.resolve({ evidenceArtifactId });
    },
  };
}

describe('VF-11 verifier browser-agent loop', () => {
  it('uses the official verifier role, exact tool allowlist, and stable completion identity', async () => {
    const requests: Array<Parameters<BrowserAgentGateway['stream']>[0]> = [];
    const driverCalls: string[] = [];
    const evidenceIds: string[] = [];
    const gateway: BrowserAgentGateway = {
      async *stream(request) {
        await Promise.resolve();
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: 'tool-call',
            toolCallId: 'call-list',
            toolName: 'listInteractive',
            input: {},
          };
        } else if (requests.length === 2) {
          yield {
            type: 'tool-call',
            toolCallId: 'call-click',
            toolName: 'click',
            input: { ref: 'element_1' },
          };
        } else {
          yield {
            type: 'text-delta',
            text: JSON.stringify({ status: 'passed', evidenceArtifactIds: evidenceIds }),
          };
        }
        yield { type: 'done' };
      },
    };
    const sessionInput = input();

    const result = await runBrowserAgentFlow(
      { ...sessionInput, flowIndex: 0, flow: firstFlow(sessionInput) },
      {
        gateway,
        driver: driver(driverCalls),
        evidence: evidence(evidenceIds),
        redact: (value) => value,
        countRequestTokens: () => 64,
      },
    );

    expect(result.status).toBe('completed');
    expect(typeof result.finalResponse).toBe('string');
    expect(driverCalls).toEqual(['listInteractive', 'click:element_1']);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.agentRole === 'verifier')).toBe(true);
    expect(
      requests.every(
        (request) =>
          request.tools?.map((tool) => tool.name).join(',') === BROWSER_AGENT_TOOL_NAMES.join(','),
      ),
    ).toBe(true);
    expect(requests.map((request) => request.completionId)).toEqual([
      browserAgentCompletionId(sessionInput, 0, 0),
      browserAgentCompletionId(sessionInput, 0, 1),
      browserAgentCompletionId(sessionInput, 0, 2),
    ]);
  });

  it('fails closed when the verifier loop requests a tool outside the allowlist', async () => {
    const gateway: BrowserAgentGateway = {
      async *stream() {
        await Promise.resolve();
        yield {
          type: 'tool-call',
          toolCallId: 'call-unknown',
          toolName: 'deleteProduction',
          input: {},
        };
        yield { type: 'done' };
      },
    };
    const sessionInput = input();
    const result = await runBrowserAgentFlow(
      { ...sessionInput, flowIndex: 0, flow: firstFlow(sessionInput) },
      {
        gateway,
        driver: driver([]),
        evidence: evidence([]),
        redact: (value) => value,
        countRequestTokens: () => 64,
      },
    );

    expect(result).toMatchObject({ status: 'failed', errorCode: 'unknown_tool' });
  });
});

describe('VF-11 per-flow budget', () => {
  it('aborts a non-cooperative gateway turn at exactly fifteen minutes', async () => {
    vi.useFakeTimers();
    try {
      const gateway: BrowserAgentGateway = {
        async *stream(_request, signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        },
      };
      const sessionInput = input();
      const pending = runBrowserAgentFlow(
        { ...sessionInput, flowIndex: 0, flow: firstFlow(sessionInput) },
        {
          gateway,
          driver: driver([]),
          evidence: evidence([]),
          redact: (value) => value,
          countRequestTokens: () => 64,
        },
      );

      await vi.advanceTimersByTimeAsync(BROWSER_AGENT_FLOW_BUDGET_MS - 1);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        status: 'budget_exhausted',
        errorCode: 'flow_budget_exhausted',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VF-11 evidence-gated findings', () => {
  it('accepts a finding only from artifacts emitted for the same flow with assertion evidence', async () => {
    const evidenceIds: string[] = [];
    let turn = 0;
    const gateway: BrowserAgentGateway = {
      async *stream() {
        await Promise.resolve();
        if (turn === 0) {
          yield {
            type: 'tool-call',
            toolCallId: 'call-list',
            toolName: 'listInteractive',
            input: {},
          };
        } else {
          yield {
            type: 'text-delta',
            text: JSON.stringify({ status: 'passed', evidenceArtifactIds: evidenceIds }),
          };
        }
        turn += 1;
        yield { type: 'done' };
      },
    };

    const result = await runBrowserAgentSession(
      input(),
      sessionDependencies(gateway, evidence(evidenceIds)),
    );

    expect(result.outcomes).toEqual([{ flow: 'update profile', status: 'completed' }]);
    expect(result.findings).toEqual([
      {
        flow: 'update profile',
        steps: [
          {
            tool: 'listInteractive',
            input: {},
            source: 'dom',
            evidenceArtifactId: evidenceIds[0],
          },
        ],
        status: 'passed',
        evidence: [{ evidenceArtifactId: evidenceIds[0], source: 'dom' }],
      },
    ]);
  });

  it.each([
    {
      name: 'missing evidence',
      toolName: undefined,
      finalResponse: () =>
        JSON.stringify({ status: 'passed', evidenceArtifactIds: [newId('art')] }),
    },
    {
      name: 'malformed JSON',
      toolName: undefined,
      finalResponse: () => '{"status":"passed"',
    },
    {
      name: 'screenshot-only evidence',
      toolName: 'screenshot',
      finalResponse: (ids: string[]) =>
        JSON.stringify({ status: 'passed', evidenceArtifactIds: ids }),
    },
  ])('drops $name instead of surfacing it as a finding', async ({ toolName, finalResponse }) => {
    const evidenceIds: string[] = [];
    let turn = 0;
    const gateway: BrowserAgentGateway = {
      async *stream() {
        await Promise.resolve();
        if (turn === 0 && toolName === 'screenshot') {
          yield {
            type: 'tool-call',
            toolCallId: 'call-screenshot',
            toolName: 'screenshot',
            input: { label: 'profile' },
          };
        } else {
          yield { type: 'text-delta', text: finalResponse(evidenceIds) };
        }
        turn += 1;
        yield { type: 'done' };
      },
    };

    const result = await runBrowserAgentSession(
      input(),
      sessionDependencies(gateway, evidence(evidenceIds)),
    );

    expect(result.findings).toEqual([]);
    expect(result.outcomes).toEqual([
      { flow: 'update profile', status: 'dropped', errorCode: 'unsupported_finding' },
    ]);
  });

  it('drops an artifact emitted by a different flow', async () => {
    const idsByFlow = new Map<string, string[]>();
    let turn = 0;
    const sessionInput: BrowserAgentSessionInput = {
      ...input(),
      flows: [
        { flow: 'first flow', journey: ['Exercise first flow'] },
        { flow: 'second flow', journey: ['Exercise second flow'] },
      ],
    };
    const sink: BrowserAgentEvidenceSink = {
      record(value) {
        const evidenceArtifactId = newId('art');
        const ids = idsByFlow.get(value.flow) ?? [];
        ids.push(evidenceArtifactId);
        idsByFlow.set(value.flow, ids);
        return Promise.resolve({ evidenceArtifactId });
      },
    };
    const gateway: BrowserAgentGateway = {
      async *stream() {
        await Promise.resolve();
        const flowIndex = Math.floor(turn / 2);
        if (turn % 2 === 0) {
          yield {
            type: 'tool-call',
            toolCallId: `call-list-${String(flowIndex)}`,
            toolName: 'listInteractive',
            input: {},
          };
        } else {
          const evidenceArtifactIds =
            flowIndex === 0 ? idsByFlow.get('first flow') : idsByFlow.get('first flow');
          yield {
            type: 'text-delta',
            text: JSON.stringify({ status: 'passed', evidenceArtifactIds }),
          };
        }
        turn += 1;
        yield { type: 'done' };
      },
    };

    const result = await runBrowserAgentSession(sessionInput, sessionDependencies(gateway, sink));

    expect(result.findings.map((finding) => finding.flow)).toEqual(['first flow']);
    expect(result.outcomes).toEqual([
      { flow: 'first flow', status: 'completed' },
      { flow: 'second flow', status: 'dropped', errorCode: 'unsupported_finding' },
    ]);
  });

  it('preserves failed and budget-exhausted flows as outcomes', async () => {
    const failedGateway: BrowserAgentGateway = {
      async *stream() {
        await Promise.resolve();
        yield {
          type: 'tool-call',
          toolCallId: 'call-unknown',
          toolName: 'deleteProduction',
          input: {},
        };
        yield { type: 'done' };
      },
    };
    const failed = await runBrowserAgentSession(
      input(),
      sessionDependencies(failedGateway, evidence([])),
    );
    expect(failed).toMatchObject({
      findings: [],
      outcomes: [{ flow: 'update profile', status: 'failed', errorCode: 'unknown_tool' }],
    });

    vi.useFakeTimers();
    try {
      const budgetGateway: BrowserAgentGateway = {
        async *stream(_request, signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        },
      };
      const pending = runBrowserAgentSession(
        input(),
        sessionDependencies(budgetGateway, evidence([])),
      );
      await vi.advanceTimersByTimeAsync(BROWSER_AGENT_FLOW_BUDGET_MS);
      await expect(pending).resolves.toMatchObject({
        findings: [],
        outcomes: [
          {
            flow: 'update profile',
            status: 'budget_exhausted',
            errorCode: 'flow_budget_exhausted',
          },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a distinct reset driver for every flow and disposes each handle', async () => {
    const drivers: FakeBrowserAgentDriver[] = [];
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const gateway: BrowserAgentGateway = {
      async *stream() {
        await Promise.resolve();
        yield { type: 'text-delta', text: 'malformed' };
        yield { type: 'done' };
      },
    };
    const dependencies = sessionDependencies(gateway, evidence([]));
    dependencies.createFlowDriver = () => {
      const nextDriver = driver([]);
      const dispose = vi.fn();
      drivers.push(nextDriver);
      disposals.push(dispose);
      return { driver: nextDriver, dispose };
    };
    const sessionInput: BrowserAgentSessionInput = {
      ...input(),
      flows: [
        { flow: 'first flow', journey: ['Exercise first flow'] },
        { flow: 'second flow', journey: ['Exercise second flow'] },
      ],
    };

    await runBrowserAgentSession(sessionInput, dependencies);

    expect(drivers).toHaveLength(2);
    expect(drivers[0]).not.toBe(drivers[1]);
    expect(drivers.every((value) => value.resetFlowState.mock.calls.length === 1)).toBe(true);
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('rejects a driver object reused across flow boundaries', async () => {
    const sharedDriver = driver([]);
    const gateway: BrowserAgentGateway = {
      async *stream() {
        await Promise.resolve();
        yield { type: 'text-delta', text: 'malformed' };
        yield { type: 'done' };
      },
    };
    const dependencies = sessionDependencies(gateway, evidence([]), () => sharedDriver);
    const sessionInput: BrowserAgentSessionInput = {
      ...input(),
      flows: [
        { flow: 'first flow', journey: ['Exercise first flow'] },
        { flow: 'second flow', journey: ['Exercise second flow'] },
      ],
    };

    const result = await runBrowserAgentSession(sessionInput, dependencies);

    expect(result.outcomes).toEqual([
      { flow: 'first flow', status: 'dropped', errorCode: 'unsupported_finding' },
      { flow: 'second flow', status: 'failed', errorCode: 'driver_reused_across_flows' },
    ]);
  });

  it('aborts a blocked evidence write at the flow deadline and cancels its driver', async () => {
    vi.useFakeTimers();
    try {
      let turn = 0;
      const gateway: BrowserAgentGateway = {
        async *stream() {
          await Promise.resolve();
          if (turn === 0) {
            yield {
              type: 'tool-call',
              toolCallId: 'call-list',
              toolName: 'listInteractive',
              input: {},
            };
          }
          turn += 1;
          yield { type: 'done' };
        },
      };
      const blockedEvidence: BrowserAgentEvidenceSink = {
        async record(_value, signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
          return { evidenceArtifactId: newId('art') };
        },
      };
      const cancellableDriver = driver([]);
      const sessionInput = input();
      const pending = runBrowserAgentFlow(
        { ...sessionInput, flowIndex: 0, flow: firstFlow(sessionInput) },
        {
          gateway,
          driver: cancellableDriver,
          evidence: blockedEvidence,
          redact: (value) => value,
          countRequestTokens: () => 64,
        },
      );

      await vi.advanceTimersByTimeAsync(BROWSER_AGENT_FLOW_BUDGET_MS);

      await expect(pending).resolves.toMatchObject({
        status: 'budget_exhausted',
        errorCode: 'flow_budget_exhausted',
      });
      expect(cancellableDriver.cancelPending.mock.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
