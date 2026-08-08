import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface TurboConfig {
  tasks?: {
    typecheck?: {
      dependsOn?: string[];
    };
  };
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const turboConfig = JSON.parse(
  readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8').replace(
    /^\s*\/\/.*$/gmu,
    '',
  ),
) as TurboConfig;
const webManifest = JSON.parse(
  readFileSync(new URL('../../../apps/web/package.json', import.meta.url), 'utf8'),
) as PackageManifest;
const rootManifest = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

describe('Turbo task graph', () => {
  it('runs each package build before its typecheck', () => {
    expect(turboConfig.tasks?.typecheck?.dependsOn).toContain('build');
  });

  it('declares the control-api workspace imported by web test sources', () => {
    const workspaceDependencies = {
      ...webManifest.dependencies,
      ...webManifest.devDependencies,
    };

    expect(workspaceDependencies['@zapp/control-api']).toBe('workspace:*');
  });

  it('keeps web tests from rebuilding shared dependency artifacts', () => {
    expect(webManifest.scripts?.['test']).toBe('playwright test');
    expect(webManifest.scripts?.['test:e2e']).toBe(
      '../../node_modules/.bin/turbo run test --filter=@zapp/web',
    );
  });

  it('serializes integration packages that reset the shared local database', () => {
    expect(rootManifest.scripts?.['verify']).toContain(
      'turbo run test:integration --filter=!@zapp/desktop --concurrency=1',
    );
  });
});
