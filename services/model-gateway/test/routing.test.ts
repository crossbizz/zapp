import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createConfiguredCompletion } from '../src/completion.js';
import { loadModelsConfig } from '../src/models.js';
import type { BackendStreamEvent, CompleteRequest } from '../src/schemas.js';
import { ProviderAttemptError, type ProviderAdapter, type ProviderInput } from '../src/providers/types.js';

const request = {
  completionId: `cmp_${'b'.repeat(64)}`,
  organizationId: 'org_1',
  projectId: 'project_1',
  runId: 'run_1',
  taskId: 'task_1',
  agentRole: 'builder',
  messages: [{ role: 'user', content: 'Build the requested feature.' }],
  cacheBreakpointMessageIndexes: [],
  maxInputTokens: 1024,
  maxOutputTokens: 2048,
} satisfies CompleteRequest;

const models = loadModelsConfig({
  roles: {
    planner: { primary: 'anthropic/planner-primary', fallbacks: ['openai/planner-fallback'] },
    builder: { primary: 'anthropic/builder-primary', fallbacks: ['openai/builder-fallback'] },
    verifier: { primary: 'anthropic/verifier-primary', fallbacks: ['openai/verifier-fallback'] },
    summarizer: {
      primary: 'anthropic/summarizer-primary',
      fallbacks: ['openai/summarizer-fallback'],
    },
  },
  providers: {
    anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    google: { apiKeyEnv: 'GEMINI_API_KEY' },
    compatible: {
      apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
      baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
      name: 'compatible',
    },
  },
});

describe('model routing configuration', () => {
  it('rejects a role whose primary and fallbacks all use the compatible transport', () => {
    expect(() =>
      loadModelsConfig({
        ...models,
        roles: {
          ...models.roles,
          builder: {
            primary: 'compatible/anthropic/claude-sonnet-4',
            fallbacks: ['compatible/openai/gpt-5', 'compatible/google/gemini-2.5-pro'],
          },
        },
      }),
    ).toThrow();
  });

  it('loads the checked-in cross-transport model configuration', async () => {
    const input = JSON.parse(
      await readFile(new URL('../config/models.json', import.meta.url), 'utf8'),
    ) as unknown;

    expect(loadModelsConfig(input).roles.builder).toEqual({
      primary: 'anthropic/claude-sonnet-5',
      fallbacks: ['openai/gpt-5', 'google/gemini-2.5-pro'],
    });
  });

  it('routes compatible vendor-qualified references with the model ID preserved', async () => {
    const compatible = provider('compatible', [
      [{ type: 'text-delta', text: 'compatible completion' }],
    ]);
    const completion = createConfiguredCompletion({
      models: loadModelsConfig({
        ...models,
        roles: {
          ...models.roles,
          builder: {
            primary: 'compatible/anthropic/claude-sonnet-4',
            fallbacks: ['openai/builder-fallback'],
          },
        },
      }),
      providers: { compatible: compatible.adapter },
    });

    await expect(collect(completion.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'text-delta', text: 'compatible completion' },
    ]);
    expect(compatible.inputs.map((input) => input.modelId)).toEqual([
      'anthropic/claude-sonnet-4',
    ]);
  });
});

interface StreamFailure {
  readonly events: readonly BackendStreamEvent[];
  readonly error: Error;
}

type Outcome = readonly BackendStreamEvent[] | Error | StreamFailure;

function stream(outcome: Outcome): AsyncIterable<BackendStreamEvent> {
  return (async function* () {
    await Promise.resolve();
    if (outcome instanceof Error) throw outcome;
    if ('events' in outcome) {
      yield* outcome.events;
      throw outcome.error;
    }
    yield* outcome;
  })();
}

function provider(providerId: ProviderAdapter['provider'], outcomes: readonly Outcome[]) {
  const inputs: ProviderInput[] = [];
  let next = 0;
  const adapter: ProviderAdapter = {
    provider: providerId,
    stream(input) {
      inputs.push(input);
      const outcome = outcomes[next];
      next += 1;
      if (outcome === undefined) throw new Error('test provider received an unexpected call');
      return stream(outcome);
    },
  };
  return { adapter, inputs };
}

function providerError(status: number): Error & { status: number } {
  return Object.assign(new Error(`provider returned ${String(status)}`), { status });
}

function aiSdkRetryableError(): Error & { readonly statusCode: undefined; readonly isRetryable: true } {
  return Object.assign(new Error('AI SDK network timeout'), {
    name: 'APICallError',
    statusCode: undefined,
    isRetryable: true as const,
  });
}

async function collect(streamToCollect: AsyncIterable<BackendStreamEvent>) {
  const events: BackendStreamEvent[] = [];
  for await (const event of streamToCollect) events.push(event);
  return events;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('configured completion routing', () => {
  it('retries 429 responses twice before the third primary attempt succeeds', async () => {
    const anthropic = provider('anthropic', [
      providerError(429),
      providerError(429),
      [{ type: 'text-delta', text: 'completed on attempt three' }],
    ]);
    const delays: number[] = [];
    const observations: unknown[] = [];
    const completion = createConfiguredCompletion({
      models,
      providers: { anthropic: anthropic.adapter },
      routing: {
        sleep: (milliseconds: number) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
        jitter: (milliseconds: number) => milliseconds,
        now: () => 100,
        observe: (observation: unknown) => {
          observations.push(observation);
        },
      },
    });

    await expect(collect(completion.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'text-delta', text: 'completed on attempt three' },
    ]);
    expect(anthropic.inputs).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
    expect(observations).toMatchObject([
      { type: 'model.attempt', model: 'anthropic/builder-primary', attempt: 1 },
      { type: 'model.attempt', model: 'anthropic/builder-primary', attempt: 2 },
      { type: 'model.attempt', model: 'anthropic/builder-primary', attempt: 3 },
    ]);
  });

  it('propagates a retryable provider error after an event without retrying or falling back', async () => {
    const failure = providerError(503);
    const anthropic = provider('anthropic', [
      { events: [{ type: 'text-delta', text: 'already sent' }], error: failure },
    ]);
    const openai = provider('openai', [[{ type: 'text-delta', text: 'must not send' }]]);
    const delays: number[] = [];
    const observations: unknown[] = [];
    const completion = createConfiguredCompletion({
      models,
      providers: { anthropic: anthropic.adapter, openai: openai.adapter },
      routing: {
        sleep: (milliseconds: number) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
        jitter: (milliseconds: number) => milliseconds,
        now: () => 100,
        observe: (observation: unknown) => {
          observations.push(observation);
        },
      },
    });
    const events: BackendStreamEvent[] = [];

    const error = await (async () => {
      for await (const event of completion.stream(request, new AbortController().signal)) {
        events.push(event);
      }
    })().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderAttemptError);
    expect(error).toMatchObject({
      provider: 'anthropic',
      model: 'builder-primary',
      cause: failure,
    });

    expect(events).toEqual([{ type: 'text-delta', text: 'already sent' }]);
    expect(anthropic.inputs).toHaveLength(1);
    expect(openai.inputs).toHaveLength(0);
    expect(delays).toEqual([]);
    expect(observations).toMatchObject([
      { type: 'model.attempt', model: 'anthropic/builder-primary', attempt: 1 },
    ]);
    expect(observations).not.toContainEqual(expect.objectContaining({ type: 'model.fallback' }));
  });

  it('retries status-less AI SDK retryable errors before a provider event', async () => {
    const anthropic = provider('anthropic', [
      aiSdkRetryableError(),
      aiSdkRetryableError(),
      [{ type: 'text-delta', text: 'completed after SDK retries' }],
    ]);
    const delays: number[] = [];
    const completion = createConfiguredCompletion({
      models,
      providers: { anthropic: anthropic.adapter },
      routing: {
        sleep: (milliseconds: number) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
        jitter: (milliseconds: number) => milliseconds,
      },
    });

    await expect(collect(completion.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'text-delta', text: 'completed after SDK retries' },
    ]);
    expect(anthropic.inputs).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
  });

  it('retries HTTP 408 as a timeout before a provider event', async () => {
    const anthropic = provider('anthropic', [
      providerError(408),
      [{ type: 'text-delta', text: 'completed after timeout' }],
    ]);
    const delays: number[] = [];
    const completion = createConfiguredCompletion({
      models,
      providers: { anthropic: anthropic.adapter },
      routing: {
        sleep: (milliseconds: number) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
        jitter: (milliseconds: number) => milliseconds,
      },
    });

    await expect(collect(completion.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'text-delta', text: 'completed after timeout' },
    ]);
    expect(anthropic.inputs).toHaveLength(2);
    expect(delays).toEqual([250]);
  });

  it('fails a 400 without retry and records the only attempt', async () => {
    const anthropic = provider('anthropic', [providerError(400)]);
    const delays: number[] = [];
    const observations: unknown[] = [];
    const completion = createConfiguredCompletion({
      models,
      providers: { anthropic: anthropic.adapter },
      routing: {
        sleep: (milliseconds: number) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
        jitter: (milliseconds: number) => milliseconds,
        now: () => 100,
        observe: (observation: unknown) => {
          observations.push(observation);
        },
      },
    });

    const error = await collect(completion.stream(request, new AbortController().signal)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      provider: 'anthropic',
      model: 'builder-primary',
    });
    expect(error).toBeInstanceOf(ProviderAttemptError);
    if (!(error instanceof ProviderAttemptError)) throw new Error('Expected attributed provider error');
    expect(error.cause).toMatchObject({ status: 400 });
    expect(anthropic.inputs).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(observations).toMatchObject([
      { type: 'model.attempt', model: 'anthropic/builder-primary', attempt: 1 },
    ]);
  });

  it('uses the next fallback after a retryable primary exhaustion and records both models', async () => {
    const anthropic = provider('anthropic', [providerError(503), providerError(503), providerError(503)]);
    const openai = provider('openai', [[{ type: 'text-delta', text: 'fallback completion' }]]);
    const observations: unknown[] = [];
    const completion = createConfiguredCompletion({
      models,
      providers: { anthropic: anthropic.adapter, openai: openai.adapter },
      routing: {
        sleep: () => Promise.resolve(),
        jitter: (milliseconds: number) => milliseconds,
        now: () => 100,
        observe: (observation: unknown) => {
          observations.push(observation);
        },
      },
    });

    await expect(collect(completion.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'text-delta', text: 'fallback completion' },
    ]);
    expect(anthropic.inputs).toHaveLength(3);
    expect(openai.inputs.map((input) => input.modelId)).toEqual(['builder-fallback']);
    expect(observations).toMatchObject([
      { type: 'model.attempt', model: 'anthropic/builder-primary', attempt: 1 },
      { type: 'model.attempt', model: 'anthropic/builder-primary', attempt: 2 },
      { type: 'model.attempt', model: 'anthropic/builder-primary', attempt: 3 },
      {
        type: 'model.fallback',
        from: 'anthropic/builder-primary',
        to: 'openai/builder-fallback',
      },
      { type: 'model.attempt', model: 'openai/builder-fallback', attempt: 1 },
    ]);
  });

  it('uses an organization role policy before the configured role default', async () => {
    const anthropic = provider('anthropic', [[{ type: 'text-delta', text: 'default' }]]);
    const openai = provider('openai', [[{ type: 'text-delta', text: 'organization policy' }]]);
    const requestedOrganizations: string[] = [];
    const completion = createConfiguredCompletion({
      models,
      providers: { anthropic: anthropic.adapter, openai: openai.adapter },
      routing: {
        organizationPolicies: {
          getPolicy(organizationId: string) {
            requestedOrganizations.push(organizationId);
            return {
              roles: {
                builder: {
                  primary: 'openai/org-builder-primary',
                  fallbacks: ['anthropic/org-builder-fallback'],
                },
              },
            };
          },
        },
      },
    });

    await expect(collect(completion.stream(request, new AbortController().signal))).resolves.toEqual([
      { type: 'text-delta', text: 'organization policy' },
    ]);
    expect(requestedOrganizations).toEqual(['org_1']);
    expect(anthropic.inputs).toHaveLength(0);
    expect(openai.inputs.map((input) => input.modelId)).toEqual(['org-builder-primary']);
  });

  it('caps concurrent streams for an organization at the configured limit', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const started: string[] = [];
    const anthropic: ProviderAdapter = {
      provider: 'anthropic',
      stream(input) {
        return (async function* () {
          started.push(input.request.runId);
          if (input.request.runId === 'run_1') {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          yield { type: 'text-delta', text: input.request.runId };
        })();
      },
    };
    const completion = createConfiguredCompletion({
      models,
      providers: { anthropic },
      routing: { maxConcurrentStreams: 1 },
    });
    const controller = new AbortController();
    const first = collect(completion.stream(request, controller.signal));
    await firstStarted.promise;
    const second = collect(completion.stream({ ...request, runId: 'run_2' }, controller.signal));

    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(started).toEqual(['run_1']);
    } finally {
      releaseFirst.resolve();
      await Promise.all([first, second]);
    }
  });
});
