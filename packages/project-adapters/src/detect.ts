import {
  DetectionResultSchema,
  type DetectionContext,
  type DetectionResult,
} from '@zapp/contracts';

import { genericNodeAdapter } from './generic-node.js';
import { frameworkAdapters } from './frameworks.js';

export * from './frameworks.js';
export * from './generic-node.js';
export * from './types.js';

export interface AdapterDetector {
  readonly id: string;
  detect(ctx: DetectionContext): Promise<DetectionResult>;
}

export async function detectProject(
  ctx: DetectionContext,
  adapters: readonly AdapterDetector[] = frameworkAdapters,
): Promise<DetectionResult[]> {
  const configured = adapters.some((adapter) => adapter.id === genericNodeAdapter.id)
    ? adapters
    : [...adapters, genericNodeAdapter];
  const detections = await Promise.all(
    configured.map(async (adapter) => DetectionResultSchema.parse(await adapter.detect(ctx))),
  );
  return detections
    .filter((result) => result.confidence > 0)
    .sort(
      (left, right) =>
        right.confidence - left.confidence || left.adapterId.localeCompare(right.adapterId),
    );
}
