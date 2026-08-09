import { createFrameworkAdapter, discoverReactRouterRoutes } from './framework-shared.js';

export const reactAdapter = createFrameworkAdapter({
  id: 'react',
  dependencies: ['react'],
  dependencyConfidence: 0.7,
  defaultPort: 3000,
  buildOutput: 'build',
  deploymentProvider: 'vercel',
  discoverRoutes: discoverReactRouterRoutes,
});
