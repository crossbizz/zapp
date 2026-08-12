export { defineEnv } from './env.js';
export {
  OBSERVABILITY_METRICS,
  buildOpenTelemetryConfig,
  createHttpServerTelemetry,
  createObservabilityInstruments,
  createSpanMetricsProcessor,
  getOpenTelemetryRuntime,
  publicOpenTelemetryConfig,
  startObservabilitySpan,
  startOpenTelemetry,
  startOpenTelemetryFromEnv,
  tenantSafeTelemetryAttributes,
  withObservabilitySpan,
  type DeploymentEnvironment,
  type HttpServerTelemetry,
  type HttpServerTelemetryFinish,
  type ObservabilityInstruments,
  type ObservabilityMetric,
  type ObservabilitySpan,
  type OpenTelemetryConfig,
  type OpenTelemetryRuntime,
  type PublicOpenTelemetryConfig,
} from './otel.js';
export {
  createTenantSafeLogger,
  redactLogValue,
  tenantSafePinoOptions,
  type LogSecretValue,
  type TenantSafeLoggerOptions,
} from './logger.js';
export {
  ANALYTICS_EVENT_NAMES,
  AnalyticsCaptureInputSchema,
  AnalyticsEventNameSchema,
  POSTHOG_DASHBOARDS,
  createProductAnalytics,
  type AnalyticsCaptureInput,
  type AnalyticsEventName,
  type ProductAnalytics,
  type ProductAnalyticsProvider,
} from './analytics.js';
export {
  FEATURE_FLAGS,
  ClientFeatureFlagsResponseSchema,
  FeatureFlagNameSchema,
  clientFeatureFlagDefaults,
  createFeatureFlagEvaluator,
  staleFeatureFlags,
  type FeatureFlagEvaluationContext,
  type FeatureFlagEvaluator,
  type FeatureFlagName,
  type FeatureFlagProvider,
  type ClientFeatureFlagsResponse,
} from './flags.js';

// Plan 02 CP-8 — the credential one zapp service presents to another. Here
// rather than in the control plane because signing and verification have to
// agree exactly, and every service already depends on this package.
export {
  createServiceTokenSigner,
  isServiceName,
  DEFAULT_SERVICE_TOKEN_TTL_SECONDS,
  MAX_SERVICE_TOKEN_TTL_SECONDS,
  SERVICE_NAMES,
  SERVICE_TOKEN_AUDIENCES,
  SERVICE_TOKEN_ISSUER,
  type IssuedServiceToken,
  type ServiceAudience,
  type ServiceName,
  type ServiceTokenClaims,
  type ServiceTokenConfig,
  type ServiceTokenRejection,
  type ServiceTokenSigner,
  type ServiceTokenVerdict,
  type SignServiceTokenInput,
} from './service-token.js';
export {
  PublicTemplateSchema,
  TemplateRegistryEntrySchema,
  TemplateRegistrySchema,
  createTemplateRegistry,
  loadTemplateRegistryFile,
  type PublicTemplate,
  type TemplateRegistryEntry,
} from './templates.js';
