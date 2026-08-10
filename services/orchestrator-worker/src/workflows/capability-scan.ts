import { proxyActivities } from '@temporalio/workflow';
import type { CapabilityScanInput, CapabilityScanOutput } from '@zapp/project-adapters';

import type { CapabilityScanActivities } from '../activities/capability-scan.js';

const { scanProjectCapabilities } = proxyActivities<CapabilityScanActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

export async function capabilityScanWorkflow(
  inputValue: CapabilityScanInput,
): Promise<CapabilityScanOutput> {
  // The activity owns the strict runtime boundary. Keeping this import type-only
  // prevents Node-only adapter dependencies from entering Temporal's deterministic bundle.
  return scanProjectCapabilities(inputValue);
}
