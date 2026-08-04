import type { FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';

/** Pino levels, ordered by severity. `silent` disables output entirely. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** What Fastify accepts as `logger`, minus the `undefined` that means "use the default". */
export type LoggerConfig = NonNullable<FastifyServerOptions['logger']>;

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
    return { requestId: request.id, method: request.method, url: request.url };
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
