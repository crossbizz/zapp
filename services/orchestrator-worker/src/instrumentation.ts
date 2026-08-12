import { startOpenTelemetryFromEnv } from '@zapp/config';

export const openTelemetry = startOpenTelemetryFromEnv({ serviceName: 'orchestrator-worker' });
