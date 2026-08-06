import { z } from 'zod';
import { ImageRecipeSchema, type ImageRecipe } from '@zapp/sandbox-service/provider-types';

export const FORGE_NODE_BASE_IMAGE =
  'node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

export const SourceRevisionSchema = z
  .object({
    repositoryUrl: z
      .string()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u,
        'Expected an immutable-source GitHub HTTPS repository URL',
      ),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/u, 'Expected a full Git commit SHA'),
  })
  .strict();
export type SourceRevision = z.infer<typeof SourceRevisionSchema>;

const BOOT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

: "\${ZAPP_AGENT_TOKEN:?ZAPP_AGENT_TOKEN is required}"
: "\${ZAPP_WORKSPACE_ROOT:=/workspace}"
mkdir -p "\${ZAPP_WORKSPACE_ROOT}"

children=()
cleanup() {
  trap - EXIT INT TERM
  if ((\${#children[@]})); then
    kill "\${children[@]}" 2>/dev/null || true
    wait "\${children[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

ZAPP_WORKSPACE_ROOT="\${ZAPP_WORKSPACE_ROOT}" node /opt/zapp/agent/dist/main.js &
agent_pid=$!
children+=("\${agent_pid}")

PORT=8080 node /opt/zapp/proxy/dist/main.js &
proxy_pid=$!
children+=("\${proxy_pid}")

if [[ -n "\${ZAPP_TELEMETRY_ENDPOINT:-}" ]]; then
  node /opt/zapp/telemetry-relay.mjs &
  children+=("$!")
fi

set +e
wait -n "\${agent_pid}" "\${proxy_pid}"
status=$?
set -e
if ((status == 0)); then
  status=1
fi
exit "\${status}"
`;

const TELEMETRY_RELAY = `const endpoint = process.env.ZAPP_TELEMETRY_ENDPOINT;
const token = process.env.ZAPP_AGENT_TOKEN;
if (!endpoint || !token) process.exit(1);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
for (;;) {
  try {
    const metricsResponse = await fetch('http://127.0.0.1:8877/metrics', {
      headers: { authorization: \`Bearer \${token}\` },
    });
    if (!metricsResponse.ok) throw new Error('workspace metrics unavailable');
    const metrics = await metricsResponse.json();
    const timeUnixNano = String(Date.parse(metrics.at) * 1_000_000);
    const point = (value) => ({ asDouble: Number(value), timeUnixNano });
    const payload = {
      resourceMetrics: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'zapp-workspace-agent' } }] },
        scopeMetrics: [{
          scope: { name: 'zapp.sandbox.telemetry-relay' },
          metrics: [
            { name: 'zapp.sandbox.active_children', gauge: { dataPoints: [point(metrics.activeChildren)] } },
            { name: 'zapp.sandbox.cpu.user', unit: 'us', gauge: { dataPoints: [point(metrics.cpu.userMicros)] } },
            { name: 'zapp.sandbox.cpu.system', unit: 'us', gauge: { dataPoints: [point(metrics.cpu.systemMicros)] } },
            { name: 'zapp.sandbox.memory.rss', unit: 'By', gauge: { dataPoints: [point(metrics.memory.rssBytes)] } },
          ],
        }],
      }],
    };
    const exportResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!exportResponse.ok) throw new Error('telemetry collector unavailable');
  } catch {
    // The relay is best-effort; sandbox-service health remains authoritative.
  }
  await delay(10_000);
}
`;

export function createForgeNodeBaseRecipe(untrustedSource: SourceRevision): ImageRecipe {
  const source = SourceRevisionSchema.parse(untrustedSource);
  const sourceDirectory = '/tmp/zapp-src';

  return ImageRecipeSchema.parse({
    imageName: 'forge-node-base',
    base: { kind: 'registry', ref: FORGE_NODE_BASE_IMAGE },
    commands: [
      'RUN sed -i -e "s|http://deb.debian.org/debian-security|https://snapshot.debian.org/archive/debian-security/20260714T000000Z|g" -e "s|http://deb.debian.org/debian|https://snapshot.debian.org/archive/debian/20260714T000000Z|g" /etc/apt/sources.list.d/debian.sources && printf \'Acquire::Check-Valid-Until "false";\\n\' > /etc/apt/apt.conf.d/99snapshot',
      'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git git-lfs ripgrep curl jq unzip build-essential python3 dumb-init && rm -rf /var/lib/apt/lists/*',
      'RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && corepack prepare yarn@1.22.22 --activate',
      `RUN git clone --filter=blob:none --no-checkout '${source.repositoryUrl}' ${sourceDirectory} && cd ${sourceDirectory} && git fetch --depth=1 origin '${source.commitSha}' && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = '${source.commitSha}'`,
      `RUN cd ${sourceDirectory} && pnpm install --frozen-lockfile`,
      `RUN cd ${sourceDirectory} && pnpm turbo run build --filter=@zapp/workspace-agent --filter=@zapp/preview-proxy --concurrency=1`,
      `RUN cd ${sourceDirectory} && pnpm --filter @zapp/workspace-agent deploy --prod /opt/zapp/agent && pnpm --filter @zapp/preview-proxy deploy --prod /opt/zapp/proxy`,
      'RUN test -f /opt/zapp/agent/dist/main.js && test -f /opt/zapp/proxy/dist/main.js && mkdir -p /workspace',
      'ENV NODE_ENV=production ZAPP_WORKSPACE_ROOT=/workspace PORT=8080',
      'WORKDIR /workspace',
    ],
    files: [
      { path: '/opt/zapp/boot.sh', mode: '0755', contents: BOOT_SCRIPT },
      {
        path: '/opt/zapp/telemetry-relay.mjs',
        mode: '0644',
        contents: TELEMETRY_RELAY,
      },
    ],
  });
}
