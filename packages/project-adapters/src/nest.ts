import { createFrameworkAdapter } from './framework-shared.js';

export const nestAdapter = createFrameworkAdapter({
  id: 'nest',
  configPatterns: [/^nest-cli\.json$/u],
  dependencies: ['@nestjs/core'],
  defaultPort: 3000,
  buildOutput: 'dist',
  deploymentProvider: 'fly',
});
