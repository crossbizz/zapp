import type { ServiceTokenSigner } from '@zapp/config';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

export const SERVICE_TOKEN_HEADER = 'x-zapp-service-token';

export class ServiceAccessError extends Error {
  constructor(
    readonly code: 'service_unauthenticated' | 'service_not_allowed',
    readonly statusCode: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceAccessError';
  }
}

function unauthenticated(): ServiceAccessError {
  return new ServiceAccessError(
    'service_unauthenticated',
    401,
    'A valid service token is required.',
  );
}

function carriesUserCredential(request: FastifyRequest): boolean {
  return (request.headers.authorization ?? '') !== '' || (request.headers.cookie ?? '') !== '';
}

/** The release plane admits only the control plane and never browser-shaped requests. */
export function createControlApiServiceAuth(options: {
  readonly signer: ServiceTokenSigner;
  readonly now?: () => Date;
}): preHandlerAsyncHookHandler {
  const now = options.now ?? (() => new Date());
  return async (request): Promise<void> => {
    if (carriesUserCredential(request)) throw unauthenticated();
    const raw = request.headers[SERVICE_TOKEN_HEADER];
    if (Array.isArray(raw)) throw unauthenticated();
    const token = raw?.trim() ?? '';
    if (token === '') throw unauthenticated();
    const verdict = await options.signer.verifyServiceToken(token, 'release-service', now());
    if (!verdict.ok) throw unauthenticated();
    if (verdict.claims.service !== 'control-api') {
      throw new ServiceAccessError(
        'service_not_allowed',
        403,
        'That service may not call this endpoint.',
      );
    }
  };
}
