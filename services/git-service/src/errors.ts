import type { ApiError as ApiErrorBody } from '@zapp/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

/**
 * The FND-10 error envelope, for this service.
 *
 * A second copy of the control plane's `src/errors.ts` rather than a shared
 * module, and that is a deliberate trade rather than an oversight: the envelope
 * *shape* is shared — it is `ApiErrorSchema` in `@zapp/contracts`, which both
 * services validate against — while the handler is a Fastify plugin that would
 * drag Fastify into a contracts package to share. What has to stay identical is
 * what a client parses, and that is the schema.
 *
 * The one rule: a message here is safe for the caller to read. Every internal
 * route of this service is called by another zapp service, but "internal" is not
 * "trusted with everything" — a Forgejo error quotes the request that failed, and
 * that request carries our admin token. Provider text never crosses this
 * boundary; it goes to the log, redacted, and the caller gets a code.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    statusCode: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const MESSAGES = {
  internal: 'An unexpected error occurred.',
  badRequest: 'The request could not be processed.',
  validation: 'The request failed validation.',
  notFound: 'The requested route does not exist.',
} as const;

function envelope(
  request: FastifyRequest,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return {
    error: { code, message, requestId: request.id, ...(details === undefined ? {} : { details }) },
  };
}

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // A route's response schema describes its *success* payload; nothing declares
  // the error envelope, so a route with a narrowed 4xx schema would have the
  // compiled serializer strip or reject this body.
  reply.serializer((payload: unknown) => JSON.stringify(payload));

  if (error instanceof ApiError) {
    if (error.statusCode >= 500) {
      request.log.error({ err: error, errorCode: error.code }, 'request failed');
    } else {
      request.log.info({ errorCode: error.code }, 'request rejected');
    }
    void reply
      .status(error.statusCode)
      .send(envelope(request, error.code, error.message, error.details));
    return;
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const details = {
      // Paths and codes only. A Zod issue carries the rejected value for several
      // issue codes, and a rejected value here is a repository ref or a commit
      // sha on its way into a log.
      issues: error.validation.map((entry) => ({
        path: [error.validationContext, ...entry.params.issue.path]
          .filter((segment): segment is string | number => segment !== undefined && segment !== '')
          .join('.'),
        code: entry.keyword,
      })),
    };
    request.log.info({ errorCode: 'validation_failed', ...details }, 'request rejected');
    void reply
      .status(400)
      .send(envelope(request, 'validation_failed', MESSAGES.validation, details));
    return;
  }

  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 400 && statusCode < 500) {
    request.log.warn({ err: error }, 'request rejected');
    void reply.status(statusCode).send(envelope(request, 'bad_request', MESSAGES.badRequest));
    return;
  }

  request.log.error({ err: error }, 'unhandled error');
  void reply.status(500).send(envelope(request, 'internal_error', MESSAGES.internal));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send(envelope(request, 'route_not_found', MESSAGES.notFound));
}
