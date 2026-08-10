import { describe, expect, test } from 'vitest';
import { IMAGE_BUILD_CONFIG } from '../images/config.js';
import { createForgeNodeBaseRecipe } from '../images/forge-node-base.js';
import { createForgeWebTestRecipe } from '../images/forge-web-test.js';

const SOURCE_REVISION = {
  repositoryUrl: 'https://github.com/crossbizz/zapp.git',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
} as const;

const ALTERNATE_CONFIG = {
  version: 1,
  node: {
    baseImage:
      'node:22.24.0-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    debianSnapshot: '20260801T000000Z',
    packageManagers: { pnpm: '9.16.0', yarn: '1.22.23' },
    gitleaks: {
      version: '8.26.0',
      linuxX64Sha256: '32faa8a77f6ce4b483921072ea89f78a794ad1d96471f2ad6e01ad3b0ebafa00',
    },
    antiSlop: {
      semgrep: {
        version: '1.172.0',
        linuxX64WheelUrl:
          'https://files.pythonhosted.org/packages/84/a5/21624510b65271a673961a894af7511b5123d662e84c74c765560ea28b27/semgrep-1.172.0-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-manylinux_2_34_x86_64.whl',
        linuxX64Sha256: 'd8b94af4266a575287ad2cd844573743ab4fe58f6bfb6d9229327807937eade3',
      },
      knip: '6.14.2',
      jscpd: '4.2.5',
      eslint: '9.39.5',
    },
  },
  webTest: {
    packageName: 'zapp-modal-browser-runtime-test',
    packageVersion: '0.0.1',
    playwright: '1.63.0',
    axeCoreCli: '4.13.0',
  },
} as const;

function recipeCommands(recipe: ReturnType<typeof createForgeNodeBaseRecipe>): string[] {
  return recipe.layers.flatMap((layer) => (layer.kind === 'plain' ? layer.commands : []));
}

describe('forge-node-base image policy', () => {
  test('validates configuration and consumes every pinned recipe assumption', () => {
    const recipe = createForgeNodeBaseRecipe(SOURCE_REVISION, ALTERNATE_CONFIG);
    const commands = recipeCommands(recipe).join('\n');

    expect(recipe.base).toEqual({ kind: 'registry', ref: ALTERNATE_CONFIG.node.baseImage });
    expect(commands).toContain(ALTERNATE_CONFIG.node.debianSnapshot);
    expect(commands).toContain(`pnpm@${ALTERNATE_CONFIG.node.packageManagers.pnpm}`);
    expect(commands).toContain(`yarn@${ALTERNATE_CONFIG.node.packageManagers.yarn}`);
    expect(commands).toContain(`gitleaks_${ALTERNATE_CONFIG.node.gitleaks.version}_linux_x64`);
    expect(commands).toContain(ALTERNATE_CONFIG.node.gitleaks.linuxX64Sha256);
    expect(commands).toContain('sha256sum --check');
    expect(commands).toContain('gitleaks version');
    expect(commands).toContain(ALTERNATE_CONFIG.node.antiSlop.semgrep.linuxX64WheelUrl);
    expect(commands).toContain(ALTERNATE_CONFIG.node.antiSlop.semgrep.linuxX64Sha256);
    expect(commands).toContain(`semgrep --version | grep -F '${ALTERNATE_CONFIG.node.antiSlop.semgrep.version}'`);
    expect(commands).toContain(`knip --version | grep -F '${ALTERNATE_CONFIG.node.antiSlop.knip}'`);
    expect(commands).toContain(`jscpd --version | grep -F '${ALTERNATE_CONFIG.node.antiSlop.jscpd}'`);
    expect(commands).toContain(`eslint --version | grep -F 'v${ALTERNATE_CONFIG.node.antiSlop.eslint}'`);

    const invalidConfigs = [
      {
        ...ALTERNATE_CONFIG,
        node: { ...ALTERNATE_CONFIG.node, debianSnapshot: 'rolling' },
      },
      {
        ...ALTERNATE_CONFIG,
        node: {
          ...ALTERNATE_CONFIG.node,
          baseImage: `node:${['latest'].join('')}@sha256:${'a'.repeat(64)}`,
        },
      },
      {
        ...ALTERNATE_CONFIG,
        node: {
          ...ALTERNATE_CONFIG.node,
          packageManagers: { ...ALTERNATE_CONFIG.node.packageManagers, pnpm: '^9.16.0' },
        },
      },
      {
        ...ALTERNATE_CONFIG,
        node: {
          ...ALTERNATE_CONFIG.node,
          antiSlop: {
            ...ALTERNATE_CONFIG.node.antiSlop,
            knip: '^6.14.2',
          },
        },
      },
      {
        ...ALTERNATE_CONFIG,
        webTest: { ...ALTERNATE_CONFIG.webTest, playwright: '~1.63.0' },
      },
    ];
    for (const invalidConfig of invalidConfigs) {
      expect(() => createForgeNodeBaseRecipe(SOURCE_REVISION, invalidConfig as never)).toThrow();
    }
  });

  test('returns a pinned Node 22 recipe with the required build and runtime tools', () => {
    const recipe = createForgeNodeBaseRecipe(SOURCE_REVISION);
    const commands = recipeCommands(recipe).join('\n');

    expect(recipe.base).toEqual({ kind: 'registry', ref: IMAGE_BUILD_CONFIG.node.baseImage });
    expect(IMAGE_BUILD_CONFIG.node.baseImage).not.toMatch(/latest/iu);
    for (const requiredPackage of [
      'git',
      'git-lfs',
      'ripgrep',
      'curl',
      'jq',
      'unzip',
      'build-essential',
      'python3',
      'python3-venv',
      'dumb-init',
    ]) {
      expect(commands).toMatch(new RegExp(`(?:^|\\s)${requiredPackage}(?:\\s|$)`, 'u'));
    }
    expect(commands).toContain('corepack enable');
    expect(commands).toContain(`pnpm@${IMAGE_BUILD_CONFIG.node.packageManagers.pnpm}`);
    expect(commands).toContain(`yarn@${IMAGE_BUILD_CONFIG.node.packageManagers.yarn}`);
    expect(commands).toContain(
      `snapshot.debian.org/archive/debian/${IMAGE_BUILD_CONFIG.node.debianSnapshot}`,
    );
  });

  test('bootstraps trusted CAs from the signed snapshot before switching it to HTTPS', () => {
    const commands = recipeCommands(createForgeNodeBaseRecipe(SOURCE_REVISION));
    const caBootstrapIndex = commands.findIndex(
      (command) => command.includes('apt-get install') && command.includes('ca-certificates'),
    );
    const httpsSnapshotIndex = commands.findIndex((command) =>
      command.includes(
        `https://snapshot.debian.org/archive/debian/${IMAGE_BUILD_CONFIG.node.debianSnapshot}`,
      ),
    );

    expect(caBootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(httpsSnapshotIndex).toBeGreaterThan(caBootstrapIndex);
    expect(commands.slice(0, caBootstrapIndex + 1).join('\n')).toContain(
      `http://snapshot.debian.org/archive/debian/${IMAGE_BUILD_CONFIG.node.debianSnapshot}`,
    );
    expect(commands.join('\n')).not.toMatch(/Verify-Peer.*false/iu);
  });

  test('fetches and verifies the exact immutable source revision before deploying both builds', () => {
    const recipe = createForgeNodeBaseRecipe(SOURCE_REVISION);
    const recipeShape = recipe as unknown as {
      layers?: Array<
        | { kind: 'plain'; commands: string[] }
        | { kind: 'source-fetch'; source: typeof SOURCE_REVISION }
      >;
    };

    expect(recipeShape.layers).toBeDefined();
    const layers = recipeShape.layers ?? [];
    const sourceLayerIndex = layers.findIndex((layer) => layer.kind === 'source-fetch');
    expect(sourceLayerIndex).toBeGreaterThanOrEqual(0);
    expect(layers.filter((layer) => layer.kind === 'source-fetch')).toHaveLength(1);
    expect(layers[sourceLayerIndex + 1]?.kind).toBe('plain');
    expect(layers[sourceLayerIndex]).toEqual({ kind: 'source-fetch', source: SOURCE_REVISION });
    const commands = layers.flatMap((layer) =>
      layer.kind === 'plain' ? layer.commands : [],
    ).join('\n');

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
  test('materializes pinned browser tools from the validated recipe configuration', () => {
    expect(() =>
      createForgeWebTestRecipe('im-base0123456789', ALTERNATE_CONFIG as never),
    ).toThrow('Browser package lock does not match image configuration');
  });

  test('extends the built base digest and pins browser, accessibility, and font tooling', () => {
    const recipe = createForgeWebTestRecipe('im-base0123456789');
    const commands = recipe.layers
      .flatMap((layer) => (layer.kind === 'plain' ? layer.commands : []))
      .join('\n');

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
      dependencies: {
        playwright: IMAGE_BUILD_CONFIG.webTest.playwright,
        '@axe-core/cli': IMAGE_BUILD_CONFIG.webTest.axeCoreCli,
      },
    });
    expect(JSON.parse(packageLock?.contents ?? '{}')).toMatchObject({
      lockfileVersion: 3,
      packages: {
        'node_modules/playwright': { version: IMAGE_BUILD_CONFIG.webTest.playwright },
        'node_modules/@axe-core/cli': { version: IMAGE_BUILD_CONFIG.webTest.axeCoreCli },
      },
    });
    expect(`${launcher?.contents ?? ''}\n${sidecar?.contents ?? ''}`).not.toContain(
      'playwright run-server',
    );
  });
});
