import { z } from 'zod';
import {
  ImageRecipeSchema,
  SourceFetchRevisionSchema,
  type ImageRecipe,
} from '@zapp/sandbox-service/provider-types';
import {
  IMAGE_BUILD_CONFIG,
  ImageBuildConfigSchema,
  type ImageBuildConfig,
} from './config.js';

export const SourceRevisionSchema = SourceFetchRevisionSchema;
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

export function createForgeNodeBaseRecipe(
  untrustedSource: SourceRevision,
  untrustedConfig: ImageBuildConfig = IMAGE_BUILD_CONFIG,
): ImageRecipe {
  const source = SourceRevisionSchema.parse(untrustedSource);
  const config = ImageBuildConfigSchema.parse(untrustedConfig);
  const sourceDirectory = '/tmp/zapp-src';
  const snapshot = config.node.debianSnapshot;
  const gitleaks = config.node.gitleaks;
  const antiSlop = config.node.antiSlop;
  const semgrepWheelPath = new URL(antiSlop.semgrep.linuxX64WheelUrl).pathname;
  const semgrepWheelFileName = semgrepWheelPath.slice(semgrepWheelPath.lastIndexOf('/') + 1);

  return ImageRecipeSchema.parse({
    imageName: 'forge-node-base',
    base: { kind: 'registry', ref: config.node.baseImage },
    layers: [
      {
        kind: 'plain',
        commands: [
          `RUN sed -i -e "s|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/${snapshot}|g" -e "s|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/${snapshot}|g" /etc/apt/sources.list.d/debian.sources && printf 'Acquire::Check-Valid-Until "false";\\n' > /etc/apt/apt.conf.d/99snapshot`,
          'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*',
          `RUN sed -i -e "s|http://snapshot.debian.org/archive/debian-security/${snapshot}|https://snapshot.debian.org/archive/debian-security/${snapshot}|g" -e "s|http://snapshot.debian.org/archive/debian/${snapshot}|https://snapshot.debian.org/archive/debian/${snapshot}|g" /etc/apt/sources.list.d/debian.sources`,
          'RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs ripgrep curl jq unzip build-essential python3 python3-venv dumb-init && rm -rf /var/lib/apt/lists/*',
          `RUN set -eux; archive=gitleaks_${gitleaks.version}_linux_x64.tar.gz; curl --fail --show-error --silent --location --output /tmp/$archive https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks.version}/$archive; printf '${gitleaks.linuxX64Sha256}  /tmp/%s\\n' "$archive" | sha256sum --check; tar -xzf /tmp/$archive -C /usr/local/bin gitleaks; chmod 0755 /usr/local/bin/gitleaks; rm -f /tmp/$archive; gitleaks version | grep -F '${gitleaks.version}'`,
          `RUN corepack enable && corepack prepare pnpm@${config.node.packageManagers.pnpm} --activate && corepack prepare yarn@${config.node.packageManagers.yarn} --activate`,
        ],
      },
      {
        kind: 'source-fetch',
        source,
      },
      {
        kind: 'plain',
        commands: [
          `RUN set -eux; wheel=/tmp/${semgrepWheelFileName}; curl --fail --show-error --silent --location --output "$wheel" ${antiSlop.semgrep.linuxX64WheelUrl}; printf '${antiSlop.semgrep.linuxX64Sha256}  %s\\n' "$wheel" | sha256sum --check; python3 -m venv /opt/zapp/semgrep; /opt/zapp/semgrep/bin/pip install --require-hashes -r ${sourceDirectory}/infra/modal/semgrep-dependencies.txt; /opt/zapp/semgrep/bin/pip install --no-deps "$wheel"; ln -s /opt/zapp/semgrep/bin/semgrep /usr/local/bin/semgrep; semgrep --version | grep -F '${antiSlop.semgrep.version}'`,
          `RUN cd ${sourceDirectory} && pnpm install --frozen-lockfile`,
          `RUN ln -s ${sourceDirectory}/node_modules/.bin/knip /usr/local/bin/knip && ln -s ${sourceDirectory}/node_modules/.bin/jscpd /usr/local/bin/jscpd && ln -s ${sourceDirectory}/node_modules/.bin/eslint /usr/local/bin/eslint && knip --version | grep -F '${antiSlop.knip}' && jscpd --version | grep -F '${antiSlop.jscpd}' && eslint --version | grep -F 'v${antiSlop.eslint}'`,
          `RUN cd ${sourceDirectory} && pnpm turbo run build --filter=@zapp/workspace-agent --filter=@zapp/preview-proxy --concurrency=1`,
          `RUN cd ${sourceDirectory} && pnpm --filter @zapp/workspace-agent deploy --prod /opt/zapp/agent && pnpm --filter @zapp/preview-proxy deploy --prod /opt/zapp/proxy`,
          'RUN test -f /opt/zapp/agent/dist/main.js && test -f /opt/zapp/proxy/dist/main.js && mkdir -p /workspace',
          'ENV NODE_ENV=production ZAPP_WORKSPACE_ROOT=/workspace PORT=8080',
          'WORKDIR /workspace',
        ],
      },
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
