import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export interface LogSecretValue {
  readonly name: string;
  readonly value: string;
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passphrase|prompt|source|code|body|token|secret|api[_-]?key|private[_-]?key)/iu;

function marker(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_.-]/gu, '_').slice(0, 80);
  return `[secret:${safeName || 'value'}]`;
}

function collectSensitiveValues(
  value: unknown,
  output: LogSecretValue[],
  seen: WeakSet<object>,
): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && typeof item === 'string' && item.length > 0) {
      output.push({ name: key, value: item });
    }
    collectSensitiveValues(item, output, seen);
  }
}

function redactText(value: string, secrets: readonly LogSecretValue[]): string {
  return secrets
    .filter(({ value: secret }) => secret.length > 0)
    .sort((left, right) => right.value.length - left.value.length)
    .reduce((current, secret) => current.split(secret.value).join(marker(secret.name)), value);
}

function redactValue(
  value: unknown,
  secrets: readonly LogSecretValue[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    const entries = Object.fromEntries(Object.entries(value));
    return redactValue(
      {
        type: value.name,
        message: value.message,
        stack: value.stack,
        ...entries,
      },
      secrets,
      seen,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? marker(key) : redactValue(item, secrets, seen),
    ]),
  );
}

export function redactLogValue(
  value: unknown,
  registeredSecrets: readonly LogSecretValue[] = [],
): unknown {
  const dynamicSecrets = [...registeredSecrets];
  collectSensitiveValues(value, dynamicSecrets, new WeakSet());
  return redactValue(value, dynamicSecrets, new WeakSet());
}

export interface TenantSafeLoggerOptions {
  readonly serviceName: string;
  readonly level?: LoggerOptions['level'];
  readonly secretValues?: readonly LogSecretValue[];
}

/**
 * One pino policy for stdout and the OTel pino instrumentation. The hook runs
 * before either destination, so a vault value has no unredacted branch.
 */
export function tenantSafePinoOptions(options: TenantSafeLoggerOptions): LoggerOptions {
  const registeredSecrets = options.secretValues ?? [];
  return {
    level: options.level ?? 'info',
    base: { service: options.serviceName },
    hooks: {
      logMethod(args, method) {
        const dynamicSecrets = [...registeredSecrets];
        for (const argument of args) {
          collectSensitiveValues(argument, dynamicSecrets, new WeakSet());
        }
        const safeArgs = args.map((argument) =>
          redactValue(argument, dynamicSecrets, new WeakSet()),
        ) as typeof args;
        method.apply(this, safeArgs);
      },
    },
  };
}

export function createTenantSafeLogger(
  options: TenantSafeLoggerOptions & {
    readonly destination?: DestinationStream;
  },
): Logger {
  const loggerOptions = tenantSafePinoOptions(options);
  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}
