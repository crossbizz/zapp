import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import fp from 'fastify-plugin';

/** Inbound and outbound name for the trace id. Lowercase: HTTP/2 field names are. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Ids we are willing to adopt from a caller: printable, bounded, and free of the
 * separators that make a header value ambiguous. An id is copied into log lines and
 * error envelopes, so an unbounded or newline-bearing string from the network would
 * be a log-forging and header-injection primitive rather than a trace.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Continues the caller's trace when they supply a usable `x-request-id`, and starts a
 * new one otherwise — so a request id always exists, is always non-empty, and is
 * always safe to echo. Wired as Fastify's `genReqId`, which makes `request.id` correct
 * from the first log line onward.
 */
export function genRequestId(req: IncomingMessage): string {
  const raw = req.headers[REQUEST_ID_HEADER];
  const inbound = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
}

/**
 * Echoes the request id on every response. Registered in `onRequest`, the earliest
 * hook, so the header survives every later outcome — a handler's payload, an error
 * envelope, a 404, or a failure in another hook.
 */
export const requestContext = fp(
  (app, _options, done) => {
    app.addHook('onRequest', (request, reply, next) => {
      reply.header(REQUEST_ID_HEADER, request.id);
      next();
    });
    done();
  },
  { name: 'request-context', fastify: '5.x' },
);
