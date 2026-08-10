import { AppPathSchema, SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import type { ExecResult } from '@zapp/workspace-runtime';
import { z } from 'zod';

import { GateResultSchema, type GateContext, type GateResult } from './registry.js';

const PREVIEW_PROXY_ORIGIN = 'http://127.0.0.1:8080';
const ACCESSIBILITY_GATE_TIMEOUT_MS = 330_000;
const MAX_CRITICAL_ROUTES = 50;
const MAX_VIOLATIONS_PER_ROUTE = 500;
const MAX_NODES_PER_VIOLATION = 100;

const AccessibilityPathSchema = AppPathSchema.max(2_048);

export const AccessibilityGateOptionsSchema = z
  .object({
    supportLevel: SupportLevelSchema,
    criticalRoutes: z.array(AccessibilityPathSchema).max(MAX_CRITICAL_ROUTES),
  })
  .strict();
export type AccessibilityGateOptions = z.infer<typeof AccessibilityGateOptionsSchema>;

const AxeImpactSchema = z.enum(['minor', 'moderate', 'serious', 'critical']).nullable();

const AxeTargetSchema = z.array(z.union([z.string(), z.array(z.string())])).max(50);

const AxeViolationNodeSchema = z
  .object({
    impact: AxeImpactSchema,
    target: AxeTargetSchema,
    failureSummary: z.string().max(10_000).nullable(),
  })
  .strict();

const AxeViolationSchema = z
  .object({
    id: z.string().min(1).max(200),
    impact: AxeImpactSchema,
    description: z.string().max(10_000),
    help: z.string().max(10_000),
    helpUrl: z.string().url().max(2_048),
    tags: z.array(z.string().max(200)).max(100),
    nodes: z.array(AxeViolationNodeSchema).max(MAX_NODES_PER_VIOLATION),
  })
  .strict();
export type AxeViolation = z.infer<typeof AxeViolationSchema>;

const AccessibilityRouteResultSchema = z
  .object({
    path: AccessibilityPathSchema,
    statusCode: z.number().int().min(100).max(599).nullable(),
    violations: z.array(AxeViolationSchema).max(MAX_VIOLATIONS_PER_ROUTE),
    scanError: z.string().max(10_000).nullable(),
  })
  .strict();
export type AccessibilityRouteResult = z.infer<typeof AccessibilityRouteResultSchema>;

const AccessibilityProbeOutputSchema = z
  .object({ routes: z.array(AccessibilityRouteResultSchema).max(MAX_CRITICAL_ROUTES) })
  .strict();

export interface AccessibilityGate {
  run(ctx: GateContext): Promise<GateResult>;
}

const ACCESSIBILITY_PROBE_PROGRAM = String.raw`
import axe from '/opt/zapp/browser/node_modules/axe-core/axe.js';
import { chromium } from '/opt/zapp/browser/node_modules/playwright/index.mjs';

const input = JSON.parse(process.env.ZAPP_AXE_PROBE_INPUT ?? 'null');
const clip = (value, max = 10000) => String(value ?? '').slice(0, max);
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const routes = [];

try {
  for (const path of input.routes) {
    const page = await browser.newPage();
    let statusCode = null;
    let violations = [];
    let scanError = null;
    try {
      const target = new URL(path, input.origin);
      if (target.origin !== input.origin) throw new Error('cross_origin_route');
      const response = await page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      if (new URL(page.url()).origin !== input.origin) {
        throw new Error('cross_origin_redirect');
      }
      statusCode = response?.status() ?? null;
      if (statusCode === null || statusCode >= 400) {
        throw new Error(statusCode === null ? 'route_status_missing' : 'route_http_status_' + statusCode);
      }
      try {
        await page.waitForLoadState('load', { timeout: 5000 });
      } catch (error) {
        void error;
      }
      await page.addScriptTag({ content: axe.source });
      const scan = await page.evaluate(async () => {
        const engine = globalThis.axe;
        if (!engine || typeof engine.run !== 'function') throw new Error('axe_injection_failed');
        return engine.run(document, { resultTypes: ['violations'] });
      });
      violations = scan.violations.slice(0, ${String(MAX_VIOLATIONS_PER_ROUTE)}).map((violation) => ({
        id: clip(violation.id, 200),
        impact: violation.impact ?? null,
        description: clip(violation.description),
        help: clip(violation.help),
        helpUrl: clip(violation.helpUrl, 2048),
        tags: violation.tags.slice(0, 100).map((tag) => clip(tag, 200)),
        nodes: violation.nodes.slice(0, ${String(MAX_NODES_PER_VIOLATION)}).map((node) => ({
          impact: node.impact ?? null,
          target: node.target.slice(0, 50),
          failureSummary: node.failureSummary === undefined || node.failureSummary === null
            ? null
            : clip(node.failureSummary),
        })),
      }));
    } catch (error) {
      scanError = clip(error instanceof Error ? error.message : 'accessibility_scan_failed');
    }
    try {
      await page.close();
    } catch (error) {
      scanError = scanError ?? clip(error instanceof Error ? error.message : 'page_close_failed');
    }
    routes.push({ path, statusCode, violations, scanError });
  }
} finally {
  await browser.close();
}

process.stdout.write(JSON.stringify({ routes }));
`;

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function parseProbeOutput(
  result: ExecResult,
  expectedRoutes: readonly string[],
): z.infer<typeof AccessibilityProbeOutputSchema> | null {
  if (result.exitCode !== 0 || result.truncated) return null;
  try {
    const parsedJson: unknown = JSON.parse(result.stdout);
    const parsed = AccessibilityProbeOutputSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.routes.length !== expectedRoutes.length) return null;
    if (parsed.data.routes.some((route, index) => route.path !== expectedRoutes[index])) return null;
    return parsed.data;
  } catch (error: unknown) {
    void error;
    return null;
  }
}

function isVerifiedOrManaged(level: SupportLevel): boolean {
  return level === 'verified' || level === 'managed';
}

function isWarning(impact: AxeViolation['impact'], supportLevel: SupportLevel): boolean {
  if (impact === 'serious') return true;
  return impact === 'critical' && supportLevel === 'compatible';
}

export function createAccessibilityGate(optionsValue: unknown): AccessibilityGate {
  const options = AccessibilityGateOptionsSchema.parse(optionsValue);
  const criticalRoutes = uniquePaths(options.criticalRoutes);

  return {
    async run(ctx) {
      if (criticalRoutes.length === 0) {
        const details = { error: 'critical_routes_missing', routeCount: 0 };
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.accessibility.summary',
          body: new TextEncoder().encode(JSON.stringify(details)),
        });
        return GateResultSchema.parse({
          status: 'not_applicable',
          evidenceArtifactIds: [artifactId],
          details,
        });
      }

      const result = await ctx.runtime.exec({
        cmd: 'node',
        args: ['--input-type=module', '-e', ACCESSIBILITY_PROBE_PROGRAM],
        cwd: ctx.contract.workspace_root,
        env: {
          ZAPP_AXE_PROBE_INPUT: JSON.stringify({
            origin: PREVIEW_PROXY_ORIGIN,
            routes: criticalRoutes,
          }),
        },
        timeoutMs: ACCESSIBILITY_GATE_TIMEOUT_MS,
      });
      const output = parseProbeOutput(result, criticalRoutes);
      if (output === null) {
        const evidence = {
          error: 'accessibility_probe_failed',
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          terminationReason: result.terminationReason,
        };
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.accessibility.summary',
          body: new TextEncoder().encode(JSON.stringify(evidence)),
        });
        return GateResultSchema.parse({
          status: 'failed',
          evidenceArtifactIds: [artifactId],
          details: { error: 'accessibility_probe_failed', routeCount: 0 },
        });
      }

      const evidenceArtifactIds: string[] = [];
      const routeSummaries: Array<Record<string, unknown>> = [];
      let criticalViolationCount = 0;
      let seriousViolationCount = 0;
      let warningCount = 0;
      let scanErrorCount = 0;

      for (const route of output.routes) {
        const routeCriticalCount = route.violations.filter(
          ({ impact }) => impact === 'critical',
        ).length;
        const routeSeriousCount = route.violations.filter(
          ({ impact }) => impact === 'serious',
        ).length;
        const routeWarningCount = route.violations.filter(({ impact }) =>
          isWarning(impact, options.supportLevel),
        ).length;
        criticalViolationCount += routeCriticalCount;
        seriousViolationCount += routeSeriousCount;
        warningCount += routeWarningCount;
        if (route.scanError !== null) scanErrorCount += 1;

        evidenceArtifactIds.push(
          await ctx.artifacts.store({
            kind: 'verification.accessibility.route',
            body: new TextEncoder().encode(
              JSON.stringify({
                ...route,
                criticalViolationCount: routeCriticalCount,
                seriousViolationCount: routeSeriousCount,
                warningCount: routeWarningCount,
              }),
            ),
          }),
        );
        routeSummaries.push({
          path: route.path,
          statusCode: route.statusCode,
          scanError: route.scanError,
          violationCount: route.violations.length,
          criticalViolationCount: routeCriticalCount,
          seriousViolationCount: routeSeriousCount,
          warningCount: routeWarningCount,
        });
      }

      const blocksOnCritical = isVerifiedOrManaged(options.supportLevel);
      const failed = scanErrorCount > 0 || (blocksOnCritical && criticalViolationCount > 0);
      const details = {
        supportLevel: options.supportLevel,
        routeCount: criticalRoutes.length,
        scannedRouteCount: output.routes.length - scanErrorCount,
        scanErrorCount,
        criticalViolationCount,
        seriousViolationCount,
        warningCount,
        threshold: { maxCriticalViolations: blocksOnCritical ? 0 : null },
        routes: routeSummaries,
      };
      return GateResultSchema.parse({
        status: failed ? 'failed' : 'passed',
        evidenceArtifactIds,
        details,
      });
    },
  };
}
