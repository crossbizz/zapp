import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import { createServiceTokenSigner } from '@zapp/config';

import { buildApp } from './app.js';
import { createConfiguredCompletion } from './completion.js';
import { loadModelGatewayEnv } from './env.js';
import { loadModelsConfig } from './models.js';
import { configureProviders } from './providers/configure.js';
import {
  createControlPlaneUsageClient,
  createUsageAccountedCompletion,
} from './usage-client.js';

const environment = loadModelGatewayEnv();
const modelConfigUrl = new URL('../config/models.json', import.meta.url);
const models = loadModelsConfig(JSON.parse(await readFile(modelConfigUrl, 'utf8')) as unknown);
const providers = configureProviders(models.providers, process.env);
const routedCompletion = createConfiguredCompletion({ models, providers: providers.enabled });
const app = buildApp({
  serviceTokens: createServiceTokenSigner(environment.serviceTokens),
  completion: createUsageAccountedCompletion({
    backend: routedCompletion,
    accounting: createControlPlaneUsageClient({
      baseUrl: environment.controlApiUrl,
      serviceTokens: environment.serviceTokens,
    }),
    claimOwner: `${hostname()}:${String(process.pid)}:${randomUUID()}`,
  }),
});

if (providers.disabled.length > 0) {
  app.log.warn(
    { disabledProviders: providers.disabled },
    'model providers disabled by missing configuration',
  );
}

await app.listen({ host: '0.0.0.0', port: environment.port });
