import { createFrameworkAdapter, discoverAstroRoutes } from './framework-shared.js';

export const astroAdapter = createFrameworkAdapter({
  id: 'astro',
  configPatterns: [/^astro\.config\.[cm]?[jt]s$/u],
  dependencies: ['astro'],
  defaultPort: 4321,
  buildOutput: 'dist',
  deploymentProvider: 'vercel',
  discoverRoutes: discoverAstroRoutes,
});
