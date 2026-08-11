import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { AppInstance } from '../../app.js';
import { ApiError } from '../../errors.js';
import {
  GitHubWebhookEventNameSchema,
  GitHubWebhookHeadersSchema,
  GitHubWebhookPayloadSchema,
} from './schemas.js';
import type { GitHubWebhookStore } from './store.js';
const AcceptedSchema = z.object({ accepted: z.literal(true) }).strict();

export interface GitHubWebhookDependencies {
  readonly secret: string;
  readonly store: GitHubWebhookStore;
  readonly now?: () => Date;
}

export function registerGitHubWebhookRoute(
  app: AppInstance,
  dependencies: GitHubWebhookDependencies,
): void {
  const now = dependencies.now ?? (() => new Date());
  app.post(
    '/v1/webhooks/github',
    {
      schema: {
        headers: GitHubWebhookHeadersSchema,
        body: z.unknown(),
        response: { 202: AcceptedSchema },
      },
    },
    async (request, reply) => {
      const raw = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(JSON.stringify(request.body));
      const rawSignature = request.headers['x-hub-signature-256'];
      const signature = Array.isArray(rawSignature) ? undefined : rawSignature;
      if (!validSignature(raw, signature, dependencies.secret)) {
        throw new ApiError('github_signature_invalid', 401, 'The GitHub signature is invalid.');
      }

      let payload: Record<string, unknown>;
      try {
        payload = GitHubWebhookPayloadSchema.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        throw new ApiError('github_payload_invalid', 400, 'The GitHub payload is invalid.');
      }
      const headers = GitHubWebhookHeadersSchema.parse(request.headers);
      const eventName = GitHubWebhookEventNameSchema.safeParse(headers['x-github-event']);
      if (!eventName.success) {
        return await reply.status(202).send({ accepted: true });
      }
      await dependencies.store.claim({
        deliveryId: headers['x-github-delivery'],
        eventName: eventName.data,
        payload,
        receivedAt: now(),
      });
      return await reply.status(202).send({ accepted: true });
    },
  );
}

function validSignature(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (signature === undefined || !/^sha256=[0-9a-f]{64}$/u.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'hex');
  const actual = Buffer.from(signature.slice('sha256='.length), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
