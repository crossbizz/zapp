import { createFrameworkAdapter, discoverSvelteKitRoutes } from './framework-shared.js';

export const svelteKitAdapter = createFrameworkAdapter({
  id: 'sveltekit',
  configPatterns: [/^svelte\.config\.[cm]?[jt]s$/u],
  dependencies: ['@sveltejs/kit'],
  defaultPort: 5173,
  buildOutput: '.svelte-kit/output',
  deploymentProvider: 'vercel',
  discoverRoutes: discoverSvelteKitRoutes,
});
