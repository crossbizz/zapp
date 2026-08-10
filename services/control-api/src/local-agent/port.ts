import {
  LocalAgentSessionSchema,
  type LocalAgentSession,
} from '@zapp/contracts';
import type {
  CompleteRequest,
  GatewayStreamEvent,
} from '@zapp/model-gateway';
import type { AuditHook } from '../plugins/audit.js';

export { LocalAgentSessionSchema, type LocalAgentSession };

export interface EnsureLocalAgentSessionInput {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly localProjectName: string;
  readonly now: Date;
  readonly audit: AuditHook<LocalAgentSession>;
}

export interface LocalAgentSessionRepository {
  ensure(input: EnsureLocalAgentSessionInput): Promise<LocalAgentSession>;
  get(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly sessionId: string;
  }): Promise<LocalAgentSession | undefined>;
}

export interface LocalAgentCompletionGateway {
  stream(request: CompleteRequest, signal: AbortSignal): AsyncIterable<GatewayStreamEvent>;
}
