import type {
  BrowserEvidencePort,
  DeploymentHealthPort,
  EnvironmentPort,
  MigrationPort,
  PreviewToolPort,
  ReleasePort,
} from '@zapp/agent-tools';

export class M1PortUnavailableError extends Error {
  public constructor(public readonly capability: string) {
    super(`${capability} is unavailable in the M1 local runtime`);
    this.name = 'M1PortUnavailableError';
  }
}

function unavailable(capability: string): () => Promise<never> {
  return () => Promise.reject(new M1PortUnavailableError(capability));
}

export interface M1UnavailablePorts {
  readonly migrations: MigrationPort;
  readonly environment: EnvironmentPort;
  readonly browser: BrowserEvidencePort;
  readonly release: ReleasePort;
  readonly preview: PreviewToolPort;
  readonly deploymentHealth: DeploymentHealthPort;
}

export function createM1UnavailablePorts(): M1UnavailablePorts {
  return {
    migrations: { executeMigration: unavailable('database migrations') },
    environment: { setEnvironmentVariable: unavailable('environment variables') },
    browser: {
      runBrowserTests: unavailable('browser tests'),
      captureScreenshot: unavailable('browser screenshots'),
      inspectConsole: unavailable('browser console inspection'),
      inspectNetwork: unavailable('browser network inspection'),
    },
    release: {
      createReleaseCandidate: unavailable('release candidates'),
      getReadiness: unavailable('release readiness'),
      approve: unavailable('release approval'),
      deploy: unavailable('release deployment'),
      rollback: unavailable('release rollback'),
      getEvidence: unavailable('release evidence'),
    },
    preview: {
      createPreview: unavailable('release previews'),
      runPreviewSmokeTest: unavailable('release preview smoke tests'),
    },
    deploymentHealth: {
      checkDeploymentHealth: unavailable('deployment health'),
    },
  };
}
