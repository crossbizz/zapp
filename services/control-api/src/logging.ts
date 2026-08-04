import type { FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';

/** Pino levels, ordered by severity. `silent` disables output entirely. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** What Fastify accepts as `logger`, minus the `undefined` that means "use the default". */
export type LoggerConfig = NonNullable<FastifyServerOptions['logger']>;

/**
 * Paths whose *shape* puts a credential in the URL, and the template each one
 * is logged as instead.
 *
 * There is normally nothing secret in a path, which is why the allowlist below
 * can pass `url` through. `POST /v1/invites/:token/accept` is the exception: the
 * token is a seven-day bearer credential (plan 02 CP-3), the route shape comes
 * from PRD §32 rather than from us, and a request line is the one place it would
 * otherwise be written down in plain text — in this service's log, and in every
 * proxy in front of it.
 *
 * Kept as a list rather than a single regex so the next route with the same
 * problem is one line, and so the reason travels with it.
 */
const CREDENTIAL_PATHS: readonly (readonly [RegExp, string])[] = [
  [/^\/v1\/invites\/[^/?#]+\/accept/, '/v1/invites/:token/accept'],
];

/** Replaces a credential-bearing path segment with its route template. */
export function redactUrl(url: string): string {
  for (const [pattern, template] of CREDENTIAL_PATHS) {
    if (pattern.test(url)) {
      return url.replace(pattern, template);
    }
  }
  return url;
}

/**
 * What a log line is allowed to say about a request and its reply.
 *
 * This is an allowlist, not a redaction list: the serializers build a fresh object
 * from three fields, so a header, a query string or a request body cannot reach the
 * log by being forgotten — only by someone editing this function. That matters most
 * for the routes this service will grow (secrets, tokens, connect credentials), where
 * the body *is* the secret. `responseTime` is added by Fastify itself.
 *
 * The parameters are narrowed to the fields each serializer reads, so a later edit
 * cannot reach for `request.body` without widening the signature first.
 */
export const logSerializers = {
  req(request: Pick<FastifyRequest, 'id' | 'method' | 'url'>) {
    return { requestId: request.id, method: request.method, url: redactUrl(request.url) };
  },
  res(reply: Pick<FastifyReply, 'statusCode'>) {
    return { statusCode: reply.statusCode };
  },
};

/**
 * Second line of defence, for objects logged by hand rather than through the
 * serializers above — `log.info({ headers })` in some future route handler.
 * Removed rather than censored so the key never appears at all.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body',
  'headers.authorization',
  'headers.cookie',
  'body',
];

/**
 * Logger configuration for {@link import('./app.js').buildApp}. `pretty` is for a
 * developer's terminal only — it loads `pino-pretty`, which is a devDependency, so
 * production must stay on the default newline-delimited JSON.
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
