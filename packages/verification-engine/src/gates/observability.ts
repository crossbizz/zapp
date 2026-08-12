import { z } from 'zod';

import { GateResultSchema, type Gate, type GateResult } from './registry.js';

const SummarySchema = z
  .object({
    missing: z.array(z.string().min(1)).max(9),
    checked: z.literal(9),
  })
  .strict();

const OBSERVABILITY_CHECK_COMMAND = String.raw`node --input-type=module <<'ZAPP_OBSERVABILITY_CHECK'
import { readFile } from 'node:fs/promises';

const read = async (path) => {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
};
const manifestSource = await read('package.json');
let manifest = {};
try { manifest = JSON.parse(manifestSource); } catch {}
const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
const faro = await read('src/observability/faro-web.ts');
const otel = await read('src/observability/otel-node.ts');
const logging = await read('src/observability/logging.ts');
const healthPaths = [
  'app/api/health/route.ts',
  'server/api/health.get.ts',
  'src/routes/api/health/+server.ts',
  'src/pages/api/health.ts',
  'api/health.ts',
  'src/routes/health.ts',
  'src/health/health.controller.ts',
  'src/observability/health.ts',
];
const health = (await Promise.all(healthPaths.map(read))).find((value) => value.length > 0) ?? '';
const checks = [
  ['frontend_errors', '@grafana/faro-web-sdk' in dependencies && faro.includes('initializeFaro')],
  ['web_vitals', faro.includes('getWebInstrumentations')],
  ['backend_tracing', '@opentelemetry/sdk-node' in dependencies && otel.includes('NodeSDK')],
  ['structured_logging', 'pino' in dependencies && logging.includes('pino')],
  ['health_endpoint', health.includes("status: 'ok'") || health.includes('status: "ok"')],
  ['release_annotation', faro.includes('ZAPP_RELEASE') && health.includes('ZAPP_RELEASE')],
  ['faro_project_isolation', faro.includes('ZAPP_PROJECT_FARO_URL') && faro.includes('ZAPP_PROJECT_ID')],
  ['otel_project_isolation', otel.includes('ZAPP_PROJECT_OTLP_ENDPOINT') && otel.includes('ZAPP_PROJECT_OTLP_TOKEN')],
  ['project_telemetry_isolation', !faro.includes('GRAFANA_FARO_URL') && !otel.includes('GRAFANA_OTLP_TOKEN')],
];
const missing = checks.filter(([, present]) => !present).map(([name]) => name);
process.stdout.write(JSON.stringify({ missing, checked: checks.length }));
if (missing.length > 0) process.exitCode = 1;
ZAPP_OBSERVABILITY_CHECK`;

function summary(stdout: string): z.infer<typeof SummarySchema> | null {
  try {
    const parsed = SummarySchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createObservabilityCheckGate(): Gate {
  return {
    id: 'observability_check',
    async run(ctx): Promise<GateResult> {
      const result = await ctx.runtime.exec({
        cmd: 'sh',
        args: ['-lc', OBSERVABILITY_CHECK_COMMAND],
        cwd: ctx.contract.workspace_root,
        timeoutMs: 30_000,
      });
      const parsed = summary(result.stdout);
      const details = parsed ?? { missing: ['invalid_observability_check_output'], checked: 0 };
      const artifactId = await ctx.artifacts.store({
        kind: 'observability-check',
        body: new TextEncoder().encode(
          JSON.stringify({
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            truncated: result.truncated,
            terminationReason: result.terminationReason,
            details,
          }),
        ),
      });
      return GateResultSchema.parse({
        status:
          result.exitCode === 0 && parsed !== null && parsed.missing.length === 0
            ? 'passed'
            : 'failed',
        evidenceArtifactIds: [artifactId],
        details,
      });
    },
  };
}
