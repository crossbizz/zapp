import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import type { BackendStreamEvent } from './schemas.js';

export interface ModelAttemptSpan {
  recordUsage(event: Extract<BackendStreamEvent, { type: 'usage' }>): void;
  end(outcome: 'ok' | 'error', error?: unknown): void;
}

export interface ModelAttemptTelemetry {
  start(input: {
    readonly provider: string;
    readonly model: string;
    readonly attempt: number;
    readonly organizationId: string;
    readonly runId: string;
    readonly taskId: string | undefined;
  }): ModelAttemptSpan;
}

function isolateTelemetry(action: () => void): void {
  try {
    action();
  } catch {
    // Telemetry is observational and must never alter completion or accounting outcomes.
  }
}

const NOOP_SPAN: ModelAttemptSpan = {
  recordUsage: () => undefined,
  end: () => undefined,
};

export function createModelAttemptTelemetry(options: {
  readonly tracer?: Tracer;
  readonly now?: () => number;
} = {}): ModelAttemptTelemetry {
  const tracer = options.tracer ?? trace.getTracer('@zapp/model-gateway');
  const now = options.now ?? Date.now;
  return {
    start(input) {
      const startedAt = now();
      let span: ReturnType<Tracer['startSpan']>;
      try {
        span = tracer.startSpan('model.completion.attempt', {
          attributes: {
            'gen_ai.provider.name': input.provider,
            'gen_ai.request.model': input.model,
            'zapp.model.attempt': input.attempt,
            'zapp.organization.id': input.organizationId,
            'zapp.run.id': input.runId,
            ...(input.taskId === undefined ? {} : { 'zapp.task.id': input.taskId }),
          },
        });
      } catch {
        return NOOP_SPAN;
      }
      let ended = false;
      return {
        recordUsage(event) {
          isolateTelemetry(() => {
            span.setAttributes({
              'gen_ai.usage.input_tokens': event.inputTokens ?? 0,
              'gen_ai.usage.output_tokens': event.outputTokens ?? 0,
              'gen_ai.usage.cache_read_input_tokens': event.cachedInputTokens ?? 0,
              'gen_ai.usage.cache_write_input_tokens': event.cacheWriteInputTokens ?? 0,
              'gen_ai.response.finish_reasons': event.finishReason,
            });
          });
        },
        end(outcome, error) {
          if (ended) return;
          ended = true;
          isolateTelemetry(() => {
            span.setAttribute('zapp.model.latency_ms', Math.max(0, now() - startedAt));
          });
          isolateTelemetry(() => {
            span.setStatus(
              outcome === 'ok'
                ? { code: SpanStatusCode.OK }
                : { code: SpanStatusCode.ERROR, message: 'model provider attempt failed' },
            );
          });
          if (outcome === 'error' && error instanceof Error) {
            isolateTelemetry(() => {
              span.recordException(error);
            });
          }
          isolateTelemetry(() => {
            span.end();
          });
        },
      };
    },
  };
}
