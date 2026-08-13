import { describe, expect, it } from 'vitest';

import { createTenantSafeLogger } from '../src/logger.js';

describe('tenant-safe pino logger', () => {
  it('redacts registered vault values and sensitive fields before stdout or OTLP can see them', () => {
    const written: string[] = [];
    const vaultValue = ['postgres://user:', 'password', '@private.example/db'].join('');
    const logger = createTenantSafeLogger({
      serviceName: 'control-api',
      destination: { write: (line: string) => written.push(line) },
      secretValues: [{ name: 'DATABASE_URL', value: vaultValue }],
    });

    logger.info(
      {
        organizationId: 'org_01J00000000000000000000000',
        projectId: 'proj_01J00000000000000000000000',
        prompt: 'write me a payroll app',
        authorization: 'Bearer customer-session-token',
        nested: { message: `provider failed while using ${vaultValue}` },
      },
      'provider request failed',
    );

    const output = written.join('');
    expect(output).not.toContain(vaultValue);
    expect(output).not.toContain('write me a payroll app');
    expect(output).not.toContain('customer-session-token');
    expect(output).toContain('[secret:DATABASE_URL]');

    const record = JSON.parse(written.at(-1) ?? '{}') as Record<string, unknown>;
    expect(record.organizationId).toBe('org_01J00000000000000000000000');
    expect(record.projectId).toBe('proj_01J00000000000000000000000');
    expect(record.prompt).toBe('[secret:prompt]');
    expect(record.authorization).toBe('[secret:authorization]');
    expect(record.nested).toEqual({ message: 'provider failed while using [secret:DATABASE_URL]' });
  });

  it('redacts errors recursively without leaking their stack or attached request body', () => {
    const written: string[] = [];
    const logger = createTenantSafeLogger({
      serviceName: 'model-gateway',
      destination: { write: (line: string) => written.push(line) },
    });
    const error = new Error('failed with provider-token');
    Object.assign(error, { token: 'provider-token', body: { code: 'customer source' } });

    logger.error({ err: error }, 'completion failed');

    const output = written.join('');
    expect(output).not.toContain('provider-token');
    expect(output).not.toContain('customer source');
    expect(output).toContain('[secret:token]');
    expect(output).toContain('[secret:body]');
  });
});
