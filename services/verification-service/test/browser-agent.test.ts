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
  type BrowserAgentEvidenceSink,
  type BrowserAgentGateway,
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

function driver(calls: string[]): BrowserAgentDriver {
  return {
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
