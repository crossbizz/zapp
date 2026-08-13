import { z } from 'zod';
import type { ImageRecipe } from '@zapp/sandbox-service/provider-types';

export const ForgeNodeOciReferenceSchema = z
  .string()
  .regex(
    /^ghcr\.io\/crossbizz\/zapp-forge-node-base:[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/u,
    'Expected the public forge-node-base GHCR tag pinned by sha256 digest',
  )
  .refine((reference) => !reference.toLowerCase().includes(':latest@'), 'latest is mutable');

export function renderOciDockerfile(recipe: ImageRecipe): string {
  if (recipe.base.kind !== 'registry') {
    throw new Error('OCI rendering requires a registry base');
  }
  const lines = [`FROM ${recipe.base.ref}`];
  for (const layer of recipe.layers) {
    if (layer.kind === 'plain') {
      lines.push(...layer.commands);
      continue;
    }
    const url = JSON.stringify(layer.source.repositoryUrl);
    const revision = JSON.stringify(layer.source.commitSha);
    lines.push(
      `RUN git clone --filter=blob:none --no-checkout ${url} /tmp/zapp-src && cd /tmp/zapp-src && git fetch --depth=1 origin ${revision} && git checkout --detach ${revision} && test "$(git rev-parse HEAD)" = ${revision}`,
    );
  }
  for (const file of recipe.files) {
    const encoded = Buffer.from(file.contents).toString('base64');
    lines.push(
      `RUN mkdir -p "$(dirname ${JSON.stringify(file.path)})" && printf '%s' ${JSON.stringify(encoded)} | base64 -d > ${JSON.stringify(file.path)} && chmod ${file.mode} ${JSON.stringify(file.path)}`,
    );
  }
  lines.push('ENTRYPOINT ["/usr/bin/dumb-init", "--", "/opt/zapp/boot.sh"]');
  return `${lines.join('\n')}\n`;
}
