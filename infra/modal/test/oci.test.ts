import { describe, expect, test } from 'vitest';
import imageLock from '../images.lock.json';
import { createForgeNodeBaseRecipe } from '../images/forge-node-base.js';
import { ForgeNodeOciReferenceSchema, renderOciDockerfile } from '../images/oci.js';

describe('public forge-node-base OCI mirror', () => {
  test('records only a public tag-and-digest GHCR reference', () => {
    expect(() => ForgeNodeOciReferenceSchema.parse(undefined)).toThrow();
    expect(() => ForgeNodeOciReferenceSchema.parse('ghcr.io/crossbizz/zapp-forge-node-base:latest')).toThrow();
    expect(() => ForgeNodeOciReferenceSchema.parse(`ghcr.io/crossbizz/zapp-forge-node-base@sha256:${'a'.repeat(64)}`)).toThrow();
    expect(() => ForgeNodeOciReferenceSchema.parse(`ghcr.io/other/zapp-forge-node-base:v1@sha256:${'a'.repeat(64)}`)).toThrow();
    expect(
      ForgeNodeOciReferenceSchema.parse(
        (imageLock as { publicMirrors?: { 'forge-node-base'?: string } }).publicMirrors?.['forge-node-base'],
      ),
    ).toMatch(/^ghcr\.io\/crossbizz\/zapp-forge-node-base:/u);
  });

  test('renders the existing provider-neutral recipe at an exact public revision', () => {
    const dockerfile = renderOciDockerfile(
      createForgeNodeBaseRecipe({
        repositoryUrl: 'https://github.com/crossbizz/zapp.git',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
      }),
    );
    expect(dockerfile).toContain('FROM node:22.23.1-bookworm-slim@sha256:');
    expect(dockerfile).toContain('git fetch --depth=1 origin "0123456789abcdef0123456789abcdef01234567"');
    expect(dockerfile).toContain('/opt/zapp/agent/dist/main.js');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/dumb-init", "--", "/opt/zapp/boot.sh"]');
    expect(dockerfile).not.toContain("from 'modal'");
  });
});
