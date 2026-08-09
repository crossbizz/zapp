import { createFrameworkAdapter, discoverReactRouterRoutes } from './framework-shared.js';

export const viteAdapter = createFrameworkAdapter({
  id: 'vite',
  configPatterns: [/^vite\.config\.[cm]?[jt]s$/u],
  dependencies: ['vite'],
  defaultPort: 5173,
  buildOutput: 'dist',
  deploymentProvider: 'vercel',
  discoverRoutes: discoverReactRouterRoutes,
});
