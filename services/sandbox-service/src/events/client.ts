import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { AgentEventObjectSchema, AgentEventSchema } from '@zapp/contracts';
import { z } from 'zod';

import {
  PreviewLifecycleEventSchema,
  type PreviewLifecycleEventPort,
} from '../routes/workspaces.js';

const EventInputSchema = AgentEventObjectSchema.omit({ id: true, sequence: true }).strict();
const EventResponseSchema = z
  .object({ events: z.array(AgentEventSchema).length(1) })
  .strict();

export interface ControlPlanePreviewEventClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export function createControlPlanePreviewEventClient(
  options: ControlPlanePreviewEventClientOptions,
): PreviewLifecycleEventPort {
  const baseUrl = z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), 'Control API URL must use HTTP or HTTPS')
    .parse(options.baseUrl);
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async emit(untrustedEvent) {
      const event = PreviewLifecycleEventSchema.parse(untrustedEvent);
      const { eventKey, ...eventInput } = event;
      const body = [EventInputSchema.parse(eventInput)];
      const { token } = await signer.signServiceToken({
        service: 'sandbox-service',
        aud: 'control-api:events.ingest',
      });
      let response: Response;
      try {
        response = await doFetch(
          new URL(`/internal/runs/${event.runId}/events`, baseUrl).toString(),
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'cache-control': 'no-store',
              'content-type': 'application/json',
              'idempotency-key': eventKey,
              'x-zapp-service-token': token,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch (error) {
        throw new Error('The preview event service could not be reached.', { cause: error });
      }
      if (response.status !== 201) {
        throw new Error(`The preview event service refused the request (${String(response.status)}).`);
      }
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch (error) {
        throw new Error('The preview event service returned invalid JSON.', { cause: error });
      }
      EventResponseSchema.parse(responseBody);
    },
  };
}
