import { createFrameworkAdapter } from './framework-shared.js';

export const expressFastifyAdapter = createFrameworkAdapter({
  id: 'express-fastify',
  dependencies: ['express', 'fastify'],
  dependencyConfidence: 0.7,
  defaultPort: 3000,
  buildOutput: null,
  deploymentProvider: 'fly',
});
