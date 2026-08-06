import { describe, expect, it } from 'vitest';
import { ExecutionContractSchema, PackageManagerSchema } from '../src/execution-contract.js';

// Transcribed from the PRD §17.2 YAML example. Every adapter must be able to emit
// this document, so it parses unchanged or the schema is wrong — never the example.
const prdExample = {
  version: 1,
  package_manager: 'pnpm',
  workspace_root: '.',
  install: { command: 'pnpm install --frozen-lockfile', timeout_seconds: 600 },
  develop: { command: 'pnpm dev --host 0.0.0.0', port: 3000 },
  build: { command: 'pnpm build', timeout_seconds: 900 },
  typecheck: { command: 'pnpm typecheck' },
  lint: { command: 'pnpm lint' },
  test: { unit: 'pnpm test', browser: 'pnpm playwright test' },
  health: { path: '/' },
};

// The blocks the PRD marks optional stripped away: what a bare project yields.
const minimalContract = {
  version: 1,
  package_manager: 'npm',
  workspace_root: 'apps/web',
  install: { command: 'npm ci' },
  develop: { command: 'npm run dev', port: 5173 },
};

describe('ExecutionContractSchema', () => {
  it('parses the PRD §17.2 example verbatim', () => {
    expect(ExecutionContractSchema.parse(prdExample)).toEqual(prdExample);
  });

  it('parses a contract carrying only the required blocks', () => {
    expect(ExecutionContractSchema.parse(minimalContract)).toEqual(minimalContract);
  });

  it('round-trips a production start block', () => {
    const withStart = { ...minimalContract, start: { command: 'node dist/server.js' } };
    expect(ExecutionContractSchema.parse(withStart)).toEqual(withStart);
    expect(
      ExecutionContractSchema.parse({ ...minimalContract, start: { command: 'npm start' } }),
    ).toEqual({ ...minimalContract, start: { command: 'npm start' } });
  });

  it('rejects a timeout on the long-lived start block', () => {
    // `start` runs the deployed server, like `develop` runs the dev one: it is meant
    // to stay up, so a wall-clock budget would only describe a healthy server as failed.
    expect(
      ExecutionContractSchema.safeParse({
        ...minimalContract,
        start: { command: 'node dist/server.js', timeout_seconds: 120 },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown key at the root', () => {
    expect(ExecutionContractSchema.safeParse({ ...prdExample, deploy: 'vercel' }).success).toBe(
      false,
    );
  });

  it('rejects a misspelled block instead of silently dropping it', () => {
    const misspelled = { ...prdExample, typechek: { command: 'pnpm typecheck' } };
    expect(ExecutionContractSchema.safeParse(misspelled).success).toBe(false);
  });

  it('rejects an unknown key inside a block', () => {
    const nestedUnknown = { ...prdExample, install: { command: 'npm ci', retries: 3 } };
    expect(ExecutionContractSchema.safeParse(nestedUnknown).success).toBe(false);
    const nestedUnknownStart = {
      ...minimalContract,
      start: { command: 'npm start', port: 3000 },
    };
    expect(ExecutionContractSchema.safeParse(nestedUnknownStart).success).toBe(false);
  });

  it('rejects a test block declaring no suite at all', () => {
    expect(ExecutionContractSchema.safeParse({ ...prdExample, test: {} }).success).toBe(false);
    for (const test of [
      { unit: 'pnpm test' },
      { browser: 'pnpm playwright test' },
      { integration: 'pnpm test:integration' },
    ]) {
      expect(ExecutionContractSchema.safeParse({ ...prdExample, test }).success).toBe(true);
    }
  });

  it('strictly round-trips an optional integration-test command', () => {
    const withIntegration = {
      ...minimalContract,
      test: { integration: 'pnpm test:integration' },
    };
    expect(ExecutionContractSchema.parse(withIntegration)).toEqual(withIntegration);
    expect(
      ExecutionContractSchema.safeParse({
        ...withIntegration,
        test: { ...withIntegration.test, integration_timeout: 60 },
      }).success,
    ).toBe(false);
  });

  it('rejects an install block with no command', () => {
    const withoutInstallCommand = { ...prdExample, install: { timeout_seconds: 600 } };
    expect(ExecutionContractSchema.safeParse(withoutInstallCommand).success).toBe(false);
  });

  it('rejects an empty command string', () => {
    const emptyCommand = { ...prdExample, install: { command: '' } };
    expect(ExecutionContractSchema.safeParse(emptyCommand).success).toBe(false);
  });

  it('rejects a missing install or develop block', () => {
    const withoutInstall: Partial<typeof prdExample> = { ...prdExample };
    delete withoutInstall.install;
    expect(ExecutionContractSchema.safeParse(withoutInstall).success).toBe(false);

    const withoutDevelop: Partial<typeof prdExample> = { ...prdExample };
    delete withoutDevelop.develop;
    expect(ExecutionContractSchema.safeParse(withoutDevelop).success).toBe(false);
  });

  it('rejects a develop block with no port', () => {
    const withoutPort = { ...prdExample, develop: { command: 'pnpm dev' } };
    expect(ExecutionContractSchema.safeParse(withoutPort).success).toBe(false);
  });

  it('rejects a port outside the TCP range', () => {
    expect(
      ExecutionContractSchema.safeParse({ ...prdExample, develop: { command: 'x', port: 0 } })
        .success,
    ).toBe(false);
    expect(
      ExecutionContractSchema.safeParse({ ...prdExample, develop: { command: 'x', port: 70_000 } })
        .success,
    ).toBe(false);
  });

  it('rejects a version other than 1', () => {
    expect(ExecutionContractSchema.safeParse({ ...prdExample, version: 2 }).success).toBe(false);
  });

  it('rejects a non-positive or fractional timeout', () => {
    expect(
      ExecutionContractSchema.safeParse({
        ...prdExample,
        install: { command: 'npm ci', timeout_seconds: 0 },
      }).success,
    ).toBe(false);
    expect(
      ExecutionContractSchema.safeParse({
        ...prdExample,
        install: { command: 'npm ci', timeout_seconds: 1.5 },
      }).success,
    ).toBe(false);
  });

  it('rejects a health path that is not rooted', () => {
    expect(
      ExecutionContractSchema.safeParse({ ...prdExample, health: { path: 'health' } }).success,
    ).toBe(false);
  });

  it('rejects a protocol-relative health path', () => {
    // `//evil.example.com/` is a URL to another origin, not a path on this app.
    expect(
      ExecutionContractSchema.safeParse({ ...prdExample, health: { path: '//evil.example.com/' } })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown package manager', () => {
    expect(
      ExecutionContractSchema.safeParse({ ...prdExample, package_manager: 'deno' }).success,
    ).toBe(false);
  });
});

describe('PackageManagerSchema', () => {
  it('is exactly the four supported managers, in order', () => {
    // Written out rather than derived: this literal is the contract, so adding,
    // dropping, renaming or reordering a manager has to fail here first.
    expect(PackageManagerSchema.options).toEqual(['npm', 'pnpm', 'yarn', 'bun']);
  });
});
