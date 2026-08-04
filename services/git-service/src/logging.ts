import type { FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';

/** Pino levels, ordered by severity. `silent` disables output entirely. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** What Fastify accepts as `logger`, minus the `undefined` that means "use the default". */
export type LoggerConfig = NonNullable<FastifyServerOptions['logger']>;

/**
 * What a log line is allowed to say about a request and its reply.
 *
 * An allowlist, not a redaction list, and the same choice the control plane makes
 * (`services/control-api/src/logging.ts`): the serializers build a fresh object
 * from three fields, so a header, a query string or a request body cannot reach
 * the log by being forgotten — only by someone editing this function.
 *
 * That matters more here than almost anywhere. Every request to this service
 * carries a service token in a header, and this service's own outbound calls
 * carry the Forgejo admin token. A default request logger prints headers.
 *
 * The parameters are narrowed to the fields each serializer reads, so a later
 * edit cannot reach for `request.body` without widening the signature first.
 */
export const logSerializers = {
  req(request: Pick<FastifyRequest, 'id' | 'method' | 'url'>) {
    // The URL is passed through: no route in this service carries a credential
    // in its path — repositories are addressed by organization and project id,
    // and a token is never a path segment (`src/routes.ts`).
    return { requestId: request.id, method: request.method, url: request.url };
  },
  res(reply: Pick<FastifyReply, 'statusCode'>) {
    return { statusCode: reply.statusCode };
  },
};

/**
 * Second line of defence, for objects logged by hand rather than through the
 * serializers above. Removed rather than censored, so the key never appears at
 * all: a `[Redacted]` marker tells a reader a credential was there, which is
 * information nobody needs and a pattern somebody will grep for.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-zapp-service-token"]',
  'req.body',
  'headers.authorization',
  'headers.cookie',
  'headers["x-zapp-service-token"]',
  'body',
  // The one this service adds: a minted repository-scoped token, on any object
  // that carries one by that name (`src/tokens.ts`).
  'token',
  '*.token',
];

/**
 * Logger configuration for {@link import('./app.js').buildApp}. `pretty` is for a
 * developer's terminal only — it loads `pino-pretty`, which is a devDependency,
 * so production must stay on the default newline-delimited JSON.
 */
export function loggerOptions(options: { level: LogLevel; pretty: boolean }): LoggerConfig {
  return {
    level: options.level,
    serializers: logSerializers,
    redact: { paths: REDACTED_LOG_PATHS, remove: true },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } } }
      : {}),
  };
}

/** Used when a caller does not supply one — JSON at `info`, never pretty. */
export const defaultLoggerOptions = loggerOptions({ level: 'info', pretty: false });
