import { AppPathSchema, CommitShaSchema, RouteSchema } from '@zapp/contracts';
import type { ExecResult } from '@zapp/workspace-runtime';
import { z } from 'zod';

import { GateResultSchema, type Gate, type GateContext } from './registry.js';

const PREVIEW_PROXY_ORIGIN = 'http://127.0.0.1:8080';
const MAX_BROWSER_ROUTES = 10;
const BROWSER_GATE_TIMEOUT_MS = 330_000;
const AUTH_ROUTE = /(?:^|\/)(?:auth|login|log-in|signin|sign-in|signup|sign-up)(?:\/|$)/iu;
const BrowserPathSchema = AppPathSchema.max(2_048);

const BrowserProbeInputSchema = z
  .object({
    origin: z.literal(PREVIEW_PROXY_ORIGIN),
    routes: z.array(BrowserPathSchema).min(1).max(50),
    authRouteCount: z.number().int().min(0).max(49),
    maxRoutes: z.number().int().min(1).max(MAX_BROWSER_ROUTES),
    captureScreenshots: z.boolean(),
    discoverNavLinks: z.boolean(),
    evidenceDirectory: z.string().regex(/^\.zapp\/evidence\/browser-smoke-[0-9a-f]{12}$/u),
  })
  .strict();

const ConsoleEntrySchema = z
  .object({
    type: z.string().min(1).max(32),
    text: z.string().max(2_000),
  })
  .strict();

const FailedRequestSchema = z
  .object({
    url: z.string().min(1).max(4_096),
    method: z.string().min(1).max(16),
    failure: z.string().max(2_000).optional(),
    status: z.number().int().min(400).max(599).optional(),
  })
  .strict();

const screenshotPathSchema = z
  .string()
  .regex(/^\.zapp\/evidence\/browser-smoke-[0-9a-f]{12}\/route-[0-9]{2}\.png$/u);

export const BrowserProbeRouteResultSchema = z
  .object({
    path: BrowserPathSchema,
    statusCode: z.number().int().min(100).max(599).nullable(),
    title: z.string().max(500),
    blankRoot: z.boolean(),
    errorBoundary: z.boolean(),
    console: z.array(ConsoleEntrySchema).max(100),
    pageErrors: z.array(z.string().max(2_000)).max(100),
    failedRequests: z.array(FailedRequestSchema).max(100),
    screenshotPath: screenshotPathSchema.nullable(),
  })
  .strict();
export type BrowserProbeRouteResult = z.infer<typeof BrowserProbeRouteResultSchema>;

const BrowserProbeOutputSchema = z
  .object({ routes: z.array(BrowserProbeRouteResultSchema).max(MAX_BROWSER_ROUTES) })
  .strict();

const BROWSER_PROBE_PROGRAM = String.raw`
import { mkdir } from 'node:fs/promises';
import { chromium } from '/opt/zapp/browser/node_modules/playwright/index.mjs';

const input = JSON.parse(process.env.ZAPP_BROWSER_PROBE_INPUT ?? 'null');
const clip = (value, max = 2000) => String(value ?? '').slice(0, max);
const unique = (values) => [...new Set(values)];
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const pending = unique(input.routes);
const visited = new Set();
const results = [];
let rootNavLinks = [];

try {
  if (input.captureScreenshots) {
    await mkdir(input.evidenceDirectory, { recursive: true });
  }
  while (pending.length > 0 && results.length < input.maxRoutes) {
    const path = pending.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    const page = await browser.newPage();
    const consoleEntries = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on('console', (message) => {
      if (consoleEntries.length < 100) {
        consoleEntries.push({ type: clip(message.type(), 32), text: clip(message.text()) });
      }
    });
    page.on('pageerror', (error) => {
      if (pageErrors.length < 100) pageErrors.push(clip(error.message));
    });
    page.on('requestfailed', (request) => {
      if (failedRequests.length < 100) {
        failedRequests.push({
          url: clip(request.url(), 4096),
          method: clip(request.method(), 16),
          failure: clip(request.failure()?.errorText),
        });
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400 && failedRequests.length < 100) {
        failedRequests.push({
          url: clip(response.url(), 4096),
          method: clip(response.request().method(), 16),
          status: response.status(),
        });
      }
    });

    let statusCode = null;
    let title = '';
    let blankRoot = true;
    let errorBoundary = false;
    let screenshotPath = null;
    try {
      const target = new URL(path, input.origin);
      if (target.origin !== input.origin) throw new Error('cross_origin_route');
      const response = await page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      statusCode = response?.status() ?? null;
      try {
        await page.waitForLoadState('load', { timeout: 5_000 });
      } catch (error) {
        void error;
      }
      title = clip(await page.title(), 500);
      const structuralState = await page.evaluate(() => {
        const root = document.querySelector('#root, #app, #__next, main') ?? document.body;
        const candidates = root ? [root, ...root.querySelectorAll('*')] : [];
        const renderable = candidates.some((node) => {
          const element = node;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            (rect.width > 0 || rect.height > 0 || (element.textContent?.trim().length ?? 0) > 0);
        });
        const boundary = document.querySelector(
          '#next-error, next-error-h1, [data-error-boundary], [data-zapp-error-boundary]',
        );
        return { blankRoot: !renderable, errorBoundary: boundary !== null };
      });
      blankRoot = structuralState.blankRoot;
      errorBoundary = structuralState.errorBoundary;

      if (path === '/' && input.discoverNavLinks) {
        rootNavLinks = await page.locator('nav a[href]').evaluateAll((links) =>
          links.map((link) => link.getAttribute('href')).filter((href) => href !== null),
        );
      }
    } catch (error) {
      pageErrors.push(clip(error instanceof Error ? error.message : 'browser_probe_failed'));
    }
    if (input.captureScreenshots) {
      const candidatePath = input.evidenceDirectory + '/route-' +
        String(results.length + 1).padStart(2, '0') + '.png';
      try {
        await page.screenshot({ path: candidatePath, fullPage: true, timeout: 10_000 });
        screenshotPath = candidatePath;
      } catch (error) {
        if (pageErrors.length < 100) {
          pageErrors.push(clip(error instanceof Error ? error.message : 'screenshot_failed'));
        }
      }
    }
    try {
      await page.close();
    } catch (error) {
      if (pageErrors.length < 100) {
        pageErrors.push(clip(error instanceof Error ? error.message : 'page_close_failed'));
      }
    }

    results.push({
      path,
      statusCode,
      title,
      blankRoot,
      errorBoundary,
      console: consoleEntries,
      pageErrors,
      failedRequests,
      screenshotPath,
    });

    if (path === '/' && input.discoverNavLinks && rootNavLinks.length > 0) {
      const authPending = pending.splice(0, input.authRouteCount);
      const remainingPending = pending.splice(0);
      const navPaths = [];
      for (const href of rootNavLinks) {
        try {
          const target = new URL(href, input.origin);
          if (
            target.origin === input.origin &&
            !target.pathname.includes('[') &&
            !visited.has(target.pathname)
          ) {
            navPaths.push(target.pathname);
          }
        } catch (error) {
          void error;
        }
      }
      pending.push(
        ...unique([...authPending, ...navPaths, ...remainingPending]).filter(
          (candidate) => !visited.has(candidate),
        ),
      );
    }
  }
} finally {
  await browser.close();
}

process.stdout.write(JSON.stringify({ routes: results }));
`;

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function prioritizedRoutes(ctx: GateContext): { readonly routes: string[]; readonly authCount: number } {
  const parsed = z.array(RouteSchema).parse(ctx.routes);
  const pagePaths = uniquePaths(
    parsed
      .filter((route) => route.kind === 'page' && !route.dynamic)
      .map((route) => route.path)
      .filter((path) => BrowserPathSchema.safeParse(path).success),
  );
  const authRoutes = pagePaths.filter((path) => path !== '/' && AUTH_ROUTE.test(path));
  const remaining = pagePaths.filter((path) => path !== '/' && !AUTH_ROUTE.test(path));
  const routes = [
    ...(pagePaths.includes('/') ? ['/'] : []),
    ...authRoutes,
    ...remaining,
  ].slice(0, 50);
  const rootOffset = routes[0] === '/' ? 1 : 0;
  return {
    routes,
    authCount: routes.slice(rootOffset).filter((path) => AUTH_ROUTE.test(path)).length,
  };
}

function parseProbeOutput(result: ExecResult): z.infer<typeof BrowserProbeOutputSchema> | null {
  if (result.exitCode !== 0 || result.truncated) return null;
  try {
    const parsedJson: unknown = JSON.parse(result.stdout);
    const parsed = BrowserProbeOutputSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    void error;
    return null;
  }
}

export async function executeBrowserProbe(
  ctx: GateContext,
  input: {
    readonly routes: readonly string[];
    readonly authRouteCount: number;
    readonly captureScreenshots: boolean;
    readonly discoverNavLinks: boolean;
    readonly maxRoutes: number;
  },
): Promise<{ readonly result: ExecResult; readonly output: z.infer<typeof BrowserProbeOutputSchema> | null }> {
  const commit = CommitShaSchema.parse(ctx.commit);
  const evidenceDirectory = `.zapp/evidence/browser-smoke-${commit.slice(0, 12)}`;
  const probeInput = BrowserProbeInputSchema.parse({
    origin: PREVIEW_PROXY_ORIGIN,
    routes: [...input.routes],
    authRouteCount: input.authRouteCount,
    maxRoutes: input.maxRoutes,
    captureScreenshots: input.captureScreenshots,
    discoverNavLinks: input.discoverNavLinks,
    evidenceDirectory,
  });
  const result = await ctx.runtime.exec({
    cmd: 'node',
    args: ['--input-type=module', '-e', BROWSER_PROBE_PROGRAM],
    cwd: ctx.contract.workspace_root,
    env: { ZAPP_BROWSER_PROBE_INPUT: JSON.stringify(probeInput) },
    timeoutMs: BROWSER_GATE_TIMEOUT_MS,
  });
  return { result, output: parseProbeOutput(result) };
}

function consoleErrorCount(route: BrowserProbeRouteResult): number {
  return route.console.filter((entry) => entry.type === 'error').length;
}

function routePassed(
  route: BrowserProbeRouteResult,
  screenshotStored: boolean,
  cleanupFailed: boolean,
): boolean {
  return (
    route.statusCode !== null &&
    route.statusCode >= 200 &&
    route.statusCode < 400 &&
    !route.blankRoot &&
    !route.errorBoundary &&
    consoleErrorCount(route) === 0 &&
    route.pageErrors.length === 0 &&
    screenshotStored &&
    !cleanupFailed
  );
}

export function createBrowserSmokeGate(): Gate {
  return {
    id: 'browser_smoke',
    async run(ctx) {
      const selected = prioritizedRoutes(ctx);
      if (selected.routes.length === 0) {
        const details = { error: 'browser_routes_missing', routeCount: 0 };
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.browser_smoke.summary',
          body: new TextEncoder().encode(JSON.stringify(details)),
        });
        return GateResultSchema.parse({
          status: 'failed',
          evidenceArtifactIds: [artifactId],
          details,
        });
      }
      const probe = await executeBrowserProbe(ctx, {
        routes: selected.routes,
        authRouteCount: selected.authCount,
        captureScreenshots: true,
        discoverNavLinks: true,
        maxRoutes: MAX_BROWSER_ROUTES,
      });
      if (probe.output === null || probe.output.routes.length === 0) {
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.browser_smoke.summary',
          body: new TextEncoder().encode(
            JSON.stringify({
              error: 'browser_probe_failed',
              exitCode: probe.result.exitCode,
              stderr: probe.result.stderr,
              stdout: probe.result.stdout,
              truncated: probe.result.truncated,
              terminationReason: probe.result.terminationReason,
            }),
          ),
        });
        return GateResultSchema.parse({
          status: 'failed',
          evidenceArtifactIds: [artifactId],
          details: { error: 'browser_probe_failed', routeCount: 0 },
        });
      }

      const evidenceArtifactIds: string[] = [];
      const summaries: Array<Record<string, unknown>> = [];
      for (const route of probe.output.routes) {
        let screenshotBase64: string | null = null;
        let screenshotReadFailed = false;
        let cleanupFailed = false;
        if (route.screenshotPath !== null) {
          try {
            screenshotBase64 = Buffer.from(await ctx.runtime.readFile(route.screenshotPath)).toString(
              'base64',
            );
          } catch (error: unknown) {
            void error;
            screenshotReadFailed = true;
          }
          try {
            await ctx.runtime.deleteFile(route.screenshotPath);
          } catch (error: unknown) {
            void error;
            cleanupFailed = true;
          }
        } else {
          screenshotReadFailed = true;
        }
        const passed = routePassed(route, screenshotBase64 !== null, cleanupFailed);
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.browser_smoke.route',
          body: new TextEncoder().encode(
            JSON.stringify({
              ...route,
              screenshotPath: undefined,
              screenshot:
                screenshotBase64 === null
                  ? null
                  : { mediaType: 'image/png', encoding: 'base64', body: screenshotBase64 },
              screenshotReadFailed,
              cleanupFailed,
              passed,
            }),
          ),
        });
        evidenceArtifactIds.push(artifactId);
        summaries.push({
          path: route.path,
          statusCode: route.statusCode,
          passed,
          blankRoot: route.blankRoot,
          errorBoundary: route.errorBoundary,
          consoleErrorCount: consoleErrorCount(route),
          pageErrorCount: route.pageErrors.length,
          failedRequestCount: route.failedRequests.length,
          screenshotReadFailed,
          cleanupFailed,
        });
      }

      const passedRouteCount = summaries.filter((summary) => summary.passed === true).length;
      const details = {
        routeCount: summaries.length,
        passedRouteCount,
        failedRouteCount: summaries.length - passedRouteCount,
        routes: summaries,
      };
      evidenceArtifactIds.push(
        await ctx.artifacts.store({
          kind: 'verification.browser_smoke.summary',
          body: new TextEncoder().encode(JSON.stringify(details)),
        }),
      );
      return GateResultSchema.parse({
        status: passedRouteCount === summaries.length ? 'passed' : 'failed',
        evidenceArtifactIds,
        details,
      });
    },
  };
}
