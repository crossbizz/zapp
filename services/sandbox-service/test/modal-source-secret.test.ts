import { beforeEach, expect, test, vi } from 'vitest';

const modalState = vi.hoisted(() => ({
  builtLayerCount: 0,
  layers: [] as Array<{ commands: string[]; params: unknown }>,
  publishedLookups: 0,
  secretLookups: [] as Array<{ name: string; params: unknown }>,
}));

vi.mock('modal', () => {
  class MockNotFoundError extends Error {}
  const sourceSecret = { secretId: 'se-source-read' };
  const createImage = (layerCount: number) => ({
    imageId: '',
    dockerfileCommands(commands: string[], params?: unknown) {
      modalState.layers.push({ commands, params });
      return createImage(layerCount + 1);
    },
    build() {
      modalState.builtLayerCount = layerCount;
      return Promise.resolve({ imageId: 'im-built0123' });
    },
  });
  const publishedImage = {
    publish() {
      return Promise.resolve();
    },
  };

  return {
    ModalClient: class {
      readonly apps = {
        fromName: () => Promise.resolve({ appId: 'ap-test' }),
      };
      readonly images = {
        fromId: () => Promise.resolve(publishedImage),
        fromName: () => {
          modalState.publishedLookups += 1;
          if (modalState.publishedLookups === 1) throw new MockNotFoundError();
          return Promise.resolve({ imageId: 'im-built0123' });
        },
        fromRegistry: () => createImage(0),
      };
      readonly secrets = {
        fromName: (name: string, params: unknown) => {
          modalState.secretLookups.push({ name, params });
          return Promise.resolve(sourceSecret);
        },
      };
      close() {}
    },
    NotFoundError: MockNotFoundError,
    Probe: { withTcp: () => ({}) },
  };
});

import { createModalImagePublisher } from '../src/provider/modal.js';

beforeEach(() => {
  modalState.builtLayerCount = 0;
  modalState.layers.length = 0;
  modalState.publishedLookups = 0;
  modalState.secretLookups.length = 0;
});

test('attaches the named source-read secret only to the explicit source-fetch layer', async () => {
  const publisher = createModalImagePublisher({
    credentials: { tokenId: 'test-modal-id', tokenSecret: 'test-modal-secret' },
  });

  await publisher.publishImage({
    environment: 'zapp-dev',
    appName: 'zapp-workspaces',
    imageName: 'forge-node-base',
    tag: '2026-08-07-abcdef0',
    publishedName: 'forge-node-base:2026-08-07-abcdef0',
    recipe: {
      imageName: 'forge-node-base',
      base: {
        kind: 'registry',
        ref: 'node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3',
      },
      layers: [
        { kind: 'plain', commands: ['RUN setup'] },
        {
          kind: 'source-fetch',
          source: {
            repositoryUrl: 'https://github.com/crossbizz/zapp.git',
            commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
          },
        },
        { kind: 'plain', commands: ['RUN build exact source'] },
      ],
      files: [],
    } as never,
  });

  expect(modalState.secretLookups).toEqual([
    {
      name: 'zapp-github-source-read',
      params: {
        environment: 'zapp-dev',
        requiredKeys: ['ZAPP_GITHUB_READ_TOKEN'],
      },
    },
  ]);
  expect(modalState.layers).toHaveLength(4);
  expect(modalState.layers[0]).toEqual({ commands: ['RUN setup'], params: undefined });
  expect(modalState.layers[1]?.params).toEqual({
    secrets: [{ secretId: 'se-source-read' }],
  });
  const sourceFetch = modalState.layers[1]?.commands.join('\n') ?? '';
  expect(sourceFetch).toContain('GIT_ASKPASS');
  expect(sourceFetch).toContain('https://github.com/crossbizz/zapp.git');
  expect(sourceFetch).toContain('abcdef0123456789abcdef0123456789abcdef01');
  expect(sourceFetch).toContain('git rev-parse HEAD');
  expect(modalState.layers[2]?.params).toBeUndefined();
  const credentialBoundary = modalState.layers[2]?.commands.join('\n') ?? '';
  expect(credentialBoundary).toContain('${ZAPP_GITHUB_READ_TOKEN+x}');
  expect(credentialBoundary).toContain('${GIT_ASKPASS+x}');
  expect(credentialBoundary).toContain('core\\.[Aa]sk[Pp]ass');
  expect(modalState.layers[3]).toEqual({
    commands: ['RUN build exact source'],
    params: undefined,
  });
  expect(modalState.builtLayerCount).toBe(4);
});
