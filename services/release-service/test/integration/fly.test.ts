import { describe, expect, it } from 'vitest';

import {
  buildFlyImage,
  detectFlyCompatibility,
  flyAppName,
  renderFlyDockerfile,
  type FlyBuildSandboxPort,
} from '../../src/providers/fly.js';

const PROJECT = 'proj_01J00000000000000000000000';
const ENVIRONMENT = 'env-production';
const COMMIT = 'a'.repeat(40);

const contract = {
  version: 1 as const,
  package_manager: 'pnpm' as const,
  workspace_root: '.',
  install: { command: 'pnpm install --frozen-lockfile', timeout_seconds: 300 },
  develop: { command: 'pnpm dev', port: 3_000 },
  build: { command: 'pnpm build', timeout_seconds: 600 },
  start: { command: 'pnpm start' },
  health: { path: '/health' },
};

function projectContext(files: Readonly<Record<string, string>>) {
  return {
    workspaceRoot: '.',
    detection: { adapterId: 'generic-node', confidence: 0.5, evidence: ['package.json'] },
    listFiles: (glob: string) =>
      Promise.resolve(Object.keys(files).filter((path) => path === glob)),
    readFile: (path: string) => {
      const value = files[path];
      return value === undefined ? Promise.reject(new Error('not found')) : Promise.resolve(value);
    },
  };
}

class RecordingBuildSandbox implements FlyBuildSandboxPort {
  readonly existing = new Set<string>();
  readonly writes: Array<{ readonly path: string; readonly contents: string }> = [];
  readonly deletes: string[] = [];
  readonly executions: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }> = [];
  exitCode = 0;
  stderr = '';

  fileExists(path: string): Promise<boolean> {
    return Promise.resolve(this.existing.has(path));
  }

  writeFile(path: string, contents: string): Promise<void> {
    this.writes.push({ path, contents });
    return Promise.resolve();
  }

  deleteFile(path: string): Promise<void> {
    this.deletes.push(path);
    return Promise.resolve();
  }

  exec(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    this.executions.push(input);
    return Promise.resolve({ exitCode: this.exitCode, stdout: 'build complete', stderr: this.stderr });
  }
}

describe('DEP-4a Fly image build and push', () => {
  it('accepts a Dockerfile without requiring package scripts', async () => {
    await expect(
      detectFlyCompatibility(projectContext({ Dockerfile: 'FROM node:22-slim\n' })),
    ).resolves.toEqual({
      providerId: 'fly',
      compatible: true,
      reasons: ['Dockerfile is present.'],
    });
  });

  it('accepts Node build and start scripts and rejects an incomplete Node project', async () => {
    await expect(
      detectFlyCompatibility(
        projectContext({
          'package.json': JSON.stringify({ scripts: { build: 'vite build', start: 'node server.js' } }),
        }),
      ),
    ).resolves.toEqual({
      providerId: 'fly',
      compatible: true,
      reasons: ['Node build and start scripts are present.'],
    });

    await expect(
      detectFlyCompatibility(
        projectContext({ 'package.json': JSON.stringify({ scripts: { build: 'vite build' } }) }),
      ),
    ).resolves.toEqual({
      providerId: 'fly',
      compatible: false,
      reasons: ['Fly requires a Dockerfile or Node build and start scripts.'],
    });
  });

  it('derives a stable provider-safe app and registry name from project and environment IDs', () => {
    expect(flyAppName(PROJECT, ENVIRONMENT)).toBe(
      'zapp-01j00000000000000000000000-production',
    );
    const longEnvironment = `env_${'B'.repeat(80)}`;
    const first = flyAppName(PROJECT, longEnvironment);
    const second = flyAppName(PROJECT, `${longEnvironment}C`);
    expect(first).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(second).not.toBe(first);
  });

  it('renders the generic Node Dockerfile with contract commands and a non-root runtime', () => {
    expect(renderFlyDockerfile(contract)).toMatchInlineSnapshot(`
      "FROM node:22-slim AS build
      WORKDIR /app
      RUN corepack enable
      COPY . .
      RUN [\"sh\",\"-lc\",\"pnpm install --frozen-lockfile\"]
      RUN [\"sh\",\"-lc\",\"pnpm build\"]

      FROM node:22-slim AS runtime
      ENV NODE_ENV=production
      WORKDIR /app
      RUN groupadd --system zapp && useradd --system --gid zapp --home /app zapp
      COPY --from=build --chown=zapp:zapp /app /app
      USER zapp
      CMD [\"sh\",\"-lc\",\"pnpm start\"]
      "
    `);
  });

  it('uses an existing Dockerfile unchanged and returns the exact-commit image artifact', async () => {
    const sandbox = new RecordingBuildSandbox();
    sandbox.existing.add('Dockerfile');
    const dockerfileContract = { ...contract, build: undefined, start: undefined };

    await expect(
      buildFlyImage(
        {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          commitSha: COMMIT,
          contract: dockerfileContract,
        },
        { sandbox },
      ),
    ).resolves.toEqual({
      kind: 'container_image',
      reference:
        'registry.fly.io/zapp-01j00000000000000000000000-production:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(sandbox.writes).toEqual([]);
    expect(sandbox.deletes).toEqual([]);
    expect(sandbox.executions).toEqual([
      {
        command: 'docker',
        args: [
          'buildx',
          'build',
          '--file',
          'Dockerfile',
          '--tag',
          'registry.fly.io/zapp-01j00000000000000000000000-production:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '--push',
          '.',
        ],
        cwd: '.',
        timeoutMs: 1_200_000,
      },
    ]);
  });

  it('writes and removes a temporary generated Dockerfile around the build', async () => {
    const sandbox = new RecordingBuildSandbox();

    await buildFlyImage(
      { projectId: PROJECT, environmentId: ENVIRONMENT, commitSha: COMMIT, contract },
      { sandbox },
    );

    expect(sandbox.writes).toEqual([
      { path: '.zapp/Dockerfile.fly', contents: renderFlyDockerfile(contract) },
    ]);
    expect(sandbox.executions[0]?.args.slice(0, 4)).toEqual([
      'buildx',
      'build',
      '--file',
      '.zapp/Dockerfile.fly',
    ]);
    expect(sandbox.deletes).toEqual(['.zapp/Dockerfile.fly']);
  });

  it('fails closed on buildx failure and still removes the generated Dockerfile', async () => {
    const sandbox = new RecordingBuildSandbox();
    sandbox.exitCode = 1;
    sandbox.stderr = 'registry push denied';

    await expect(
      buildFlyImage(
        { projectId: PROJECT, environmentId: ENVIRONMENT, commitSha: COMMIT, contract },
        { sandbox },
      ),
    ).rejects.toMatchObject({ code: 'fly_image_build_failed' });
    expect(sandbox.deletes).toEqual(['.zapp/Dockerfile.fly']);
  });
});
