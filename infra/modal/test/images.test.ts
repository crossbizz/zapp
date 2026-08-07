import { describe, expect, test } from 'vitest';
import { FORGE_NODE_BASE_IMAGE, createForgeNodeBaseRecipe } from '../images/forge-node-base.js';
import { createForgeWebTestRecipe } from '../images/forge-web-test.js';

const SOURCE_REVISION = {
  repositoryUrl: 'https://github.com/crossbizz/zapp.git',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
} as const;

describe('forge-node-base image policy', () => {
  test('returns a pinned Node 22 recipe with the required build and runtime tools', () => {
    const recipe = createForgeNodeBaseRecipe(SOURCE_REVISION);
    const commands = recipe.commands.join('\n');

    expect(recipe.base).toEqual({ kind: 'registry', ref: FORGE_NODE_BASE_IMAGE });
    expect(FORGE_NODE_BASE_IMAGE).toBe(
      'node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3',
    );
    expect(FORGE_NODE_BASE_IMAGE).not.toMatch(/latest/iu);
    for (const requiredPackage of [
      'git',
      'git-lfs',
      'ripgrep',
      'curl',
      'jq',
      'unzip',
      'build-essential',
      'python3',
      'dumb-init',
    ]) {
      expect(commands).toMatch(new RegExp(`(?:^|\\s)${requiredPackage}(?:\\s|$)`, 'u'));
    }
    expect(commands).toContain('corepack enable');
    expect(commands).toContain('pnpm@9.15.0');
    expect(commands).toContain('yarn@1.22.22');
    expect(commands).toContain('snapshot.debian.org/archive/debian/20260714T000000Z');
  });

  test('bootstraps trusted CAs from the signed snapshot before switching it to HTTPS', () => {
    const commands = createForgeNodeBaseRecipe(SOURCE_REVISION).commands;
    const caBootstrapIndex = commands.findIndex(
      (command) => command.includes('apt-get install') && command.includes('ca-certificates'),
    );
    const httpsSnapshotIndex = commands.findIndex((command) =>
      command.includes('https://snapshot.debian.org/archive/debian/20260714T000000Z'),
    );

    expect(caBootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(httpsSnapshotIndex).toBeGreaterThan(caBootstrapIndex);
    expect(commands.slice(0, caBootstrapIndex + 1).join('\n')).toContain(
      'http://snapshot.debian.org/archive/debian/20260714T000000Z',
    );
    expect(commands.join('\n')).not.toMatch(/Verify-Peer.*false/iu);
  });

  test('fetches and verifies the exact immutable source revision before deploying both builds', () => {
    const recipe = createForgeNodeBaseRecipe(SOURCE_REVISION);
    const commands = recipe.commands.join('\n');

    expect(commands).toContain(SOURCE_REVISION.repositoryUrl);
    expect(commands).toContain(SOURCE_REVISION.commitSha);
    expect(commands).toContain('git rev-parse HEAD');
    expect(commands).toContain('@zapp/workspace-agent');
    expect(commands).toContain('@zapp/preview-proxy');
    expect(commands).toContain('/opt/zapp/agent');
    expect(commands).toContain('/opt/zapp/proxy');
  });

  test('boots the authenticated agent, preview proxy, and credential-free telemetry relay', () => {
    const recipe = createForgeNodeBaseRecipe(SOURCE_REVISION);
    const boot = recipe.files.find((file) => file.path === '/opt/zapp/boot.sh');
    const telemetry = recipe.files.find((file) => file.path === '/opt/zapp/telemetry-relay.mjs');

    expect(boot).toMatchObject({ mode: '0755' });
    expect(boot?.contents).toContain('ZAPP_AGENT_TOKEN');
    expect(boot?.contents).toContain('ZAPP_WORKSPACE_ROOT');
    expect(boot?.contents).toContain('/opt/zapp/agent/dist/main.js');
    expect(boot?.contents).toContain('/opt/zapp/proxy/dist/main.js');
    expect(boot?.contents).toContain('PORT=8080');
    expect(boot?.contents).toContain('wait -n');
    expect(boot?.contents).toContain('trap');
    expect(telemetry?.contents).toContain('ZAPP_TELEMETRY_ENDPOINT');
    expect(telemetry?.contents).toContain('http://127.0.0.1:8877/metrics');
    expect(telemetry?.contents).toContain('resourceMetrics');
    expect(`${boot?.contents ?? ''}\n${telemetry?.contents ?? ''}`).not.toMatch(
      /grafana|api[_-]?key|otlp[_-]?token/iu,
    );
  });
});

describe('forge-web-test image policy', () => {
  test('extends the built base digest and pins browser, accessibility, and font tooling', () => {
    const recipe = createForgeWebTestRecipe('im-base0123456789');
    const commands = recipe.commands.join('\n');

    expect(recipe.base).toEqual({ kind: 'publication', digest: 'im-base0123456789' });
    expect(commands).toContain('npm ci --prefix /opt/zapp/browser');
    expect(commands).not.toContain('npm install --prefix /opt/zapp/browser');
    expect(commands).toContain('playwright install --with-deps chromium');
    expect(commands).toContain('fonts-noto-color-emoji');
    expect(commands).not.toMatch(/@latest|:latest/iu);
    const launcher = recipe.files.find((file) => file.path === '/opt/zapp/browser-sidecar.sh');
    const sidecar = recipe.files.find((file) => file.path === '/opt/zapp/browser-sidecar.mjs');
    const packageLock = recipe.files.find(
      (file) => file.path === '/opt/zapp/browser/package-lock.json',
    );
    const packageJson = recipe.files.find((file) => file.path === '/opt/zapp/browser/package.json');
    expect(launcher).toMatchObject({ mode: '0755' });
    expect(launcher?.contents).toContain('/opt/zapp/browser-sidecar.mjs');
    expect(sidecar?.contents).toContain('chromium.executablePath()');
    expect(sidecar?.contents).toContain('--remote-debugging-port=');
    expect(sidecar?.contents).toContain("process.once('SIGTERM'");
    expect(sidecar?.contents).toContain("process.once('SIGINT'");
    expect(sidecar?.contents).toContain("browser.once('error'");
    expect(sidecar?.contents).toContain('process.exitCode = 1');
    expect(JSON.parse(packageJson?.contents ?? '{}')).toMatchObject({
      dependencies: { playwright: '1.62.1', '@axe-core/cli': '4.12.1' },
    });
    expect(JSON.parse(packageLock?.contents ?? '{}')).toMatchObject({
      lockfileVersion: 3,
      packages: {
        'node_modules/playwright': { version: '1.62.1' },
        'node_modules/@axe-core/cli': { version: '4.12.1' },
      },
    });
    expect(`${launcher?.contents ?? ''}\n${sidecar?.contents ?? ''}`).not.toContain(
      'playwright run-server',
    );
  });
});
