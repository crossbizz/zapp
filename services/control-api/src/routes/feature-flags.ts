import {
  ClientFeatureFlagsResponseSchema,
  type FeatureFlagEvaluator,
} from '@zapp/config';

import type { AppInstance } from '../app.js';
import { actorOf } from '../plugins/auth.js';
import { tenantOf } from '../plugins/tenant.js';

export function registerFeatureFlagRoutes(
  app: AppInstance,
  evaluator: FeatureFlagEvaluator,
): void {
  app.get(
    '/v1/feature-flags',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { response: { 200: ClientFeatureFlagsResponseSchema } },
    },
    async (request) => {
      const organizationId = tenantOf(request).organizationId;
      const context = { organizationId, distinctId: actorOf(request) };
      const [voiceInput, mobileAppTab, visualEditing] = await Promise.all([
        evaluator.evaluate('voice-input', context),
        evaluator.evaluate('mobile-app-tab', context),
        evaluator.evaluate('visual-editing', context),
      ]);
      return {
        flags: {
          'voice-input': voiceInput,
          'mobile-app-tab': mobileAppTab,
          'visual-editing': visualEditing,
        },
      };
    },
  );
}
