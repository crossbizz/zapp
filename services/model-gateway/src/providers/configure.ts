import type { ProviderConfig, ProviderId } from '../models.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createCompatibleAdapter } from './compatible.js';
import { createGoogleAdapter } from './google.js';
import { createOpenAIAdapter } from './openai.js';
import type { ProviderAdapter } from './types.js';

export interface DisabledProvider {
  readonly provider: ProviderId;
  readonly code: 'missing_configuration';
  readonly missing: string[];
}

export interface ConfiguredProviders {
  readonly enabled: Partial<Record<ProviderId, ProviderAdapter>>;
  readonly disabled: DisabledProvider[];
}

function configuredValue(environment: Readonly<Record<string, string | undefined>>, name: string) {
  const value = environment[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function standardValues(
  config: ProviderConfig['anthropic'],
  environment: Readonly<Record<string, string | undefined>>,
) {
  const apiKey = configuredValue(environment, config.apiKeyEnv);
  const baseURL =
    config.baseUrlEnv === undefined
      ? undefined
      : configuredValue(environment, config.baseUrlEnv);
  const missing = [
    ...(apiKey === undefined ? [config.apiKeyEnv] : []),
    ...(config.baseUrlEnv !== undefined && baseURL === undefined ? [config.baseUrlEnv] : []),
  ];
  return { apiKey, baseURL, missing };
}

export function configureProviders(
  config: ProviderConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ConfiguredProviders {
  const enabled: Partial<Record<ProviderId, ProviderAdapter>> = {};
  const disabled: DisabledProvider[] = [];

  const anthropic = standardValues(config.anthropic, environment);
  if (anthropic.apiKey === undefined || anthropic.missing.length > 0) {
    disabled.push({ provider: 'anthropic', code: 'missing_configuration', missing: anthropic.missing });
  } else {
    enabled.anthropic = createAnthropicAdapter({
      apiKey: anthropic.apiKey,
      ...(anthropic.baseURL === undefined ? {} : { baseURL: anthropic.baseURL }),
    });
  }

  const openai = standardValues(config.openai, environment);
  if (openai.apiKey === undefined || openai.missing.length > 0) {
    disabled.push({ provider: 'openai', code: 'missing_configuration', missing: openai.missing });
  } else {
    enabled.openai = createOpenAIAdapter({
      apiKey: openai.apiKey,
      ...(openai.baseURL === undefined ? {} : { baseURL: openai.baseURL }),
    });
  }

  const google = standardValues(config.google, environment);
  if (google.apiKey === undefined || google.missing.length > 0) {
    disabled.push({ provider: 'google', code: 'missing_configuration', missing: google.missing });
  } else {
    enabled.google = createGoogleAdapter({
      apiKey: google.apiKey,
      ...(google.baseURL === undefined ? {} : { baseURL: google.baseURL }),
    });
  }

  const compatibleApiKey = configuredValue(environment, config.compatible.apiKeyEnv);
  const compatibleBaseURL = configuredValue(environment, config.compatible.baseUrlEnv);
  const compatibleMissing = [
    ...(compatibleApiKey === undefined ? [config.compatible.apiKeyEnv] : []),
    ...(compatibleBaseURL === undefined ? [config.compatible.baseUrlEnv] : []),
  ];
  if (compatibleApiKey === undefined || compatibleBaseURL === undefined) {
    disabled.push({
      provider: 'compatible',
      code: 'missing_configuration',
      missing: compatibleMissing,
    });
  } else {
    enabled.compatible = createCompatibleAdapter({
      apiKey: compatibleApiKey,
      baseURL: compatibleBaseURL,
      name: config.compatible.name,
    });
  }

  return { enabled, disabled };
}
