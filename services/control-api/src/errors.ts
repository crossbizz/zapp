import type { ApiError as ApiErrorBody } from '@zapp/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  type ZodFastifySchemaValidationError,
} from 'fastify-type-provider-zod';

/**
 * The only way a handler should fail on purpose. Everything it carries is meant for
 * the client: `code` is the machine string documented in the PRD (`project_not_found`,
 * `budget_exceeded`), `message` is tenant-safe prose, and `details` is structured
 * context a client can render. Anything the client must not see belongs in the log,
 * not in here.
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

/**
 * Bodies for the errors we raise ourselves, held to the same tenant-safe standard as
 * an `ApiError` message: they name what happened, never why, and never quote input.
 */
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

/**
 * Which field failed and how — never what was in it. A Zod issue carries the rejected
 * value in `received`/`message` for several issue codes, so only the path and the code
 * cross the boundary; the caller already knows what they sent.
 */
function validationDetails(
  error: Omit<FastifyError, 'validation'> & { validation: ZodFastifySchemaValidationError[] },
): Record<string, unknown> {
  return {
    issues: error.validation.map((entry) => ({
      path: [error.validationContext, ...entry.params.issue.path]
        .filter((segment): segment is string | number => segment !== undefined && segment !== '')
        .join('.'),
      code: entry.keyword,
    })),
  };
}

/**
 * Every non-2xx body this service emits is built here, so the FND-10 envelope cannot
 * drift route by route. Four cases, in order:
 *
 * 1. `ApiError` — a deliberate failure, passed through as authored.
 * 2. Zod schema rejection — 400 `validation_failed` with paths only.
 * 3. Any other 4xx (malformed JSON, unsupported media type, oversized payload) — the
 *    status is honest but the framework's wording is not ours to leak.
 * 4. Anything else — 500 `internal_error`. The message is fixed, the stack goes to
 *    the log, and the client learns only its request id, which is what support needs.
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // A route's response schema describes its *success* payload; nothing declares
  // the error envelope, so a route with a narrowed `404` (or `4xx`) schema would
  // have the serializer compiled from that schema strip or reject this body.
  // Errors are serialized as plain JSON, which is what makes the envelope a
  // property of the service rather than of each route's schema.
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
    const details = validationDetails(error);
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

/** A route that does not exist is an error like any other, and says so in the envelope. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send(envelope(request, 'route_not_found', MESSAGES.notFound));
}
