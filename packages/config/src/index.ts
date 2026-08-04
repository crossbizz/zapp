export { defineEnv } from './env.js';

// Plan 02 CP-8 — the credential one zapp service presents to another. Here
// rather than in the control plane because signing and verification have to
// agree exactly, and every service already depends on this package.
export {
  createServiceTokenSigner,
  isServiceName,
  DEFAULT_SERVICE_TOKEN_TTL_SECONDS,
  MAX_SERVICE_TOKEN_TTL_SECONDS,
  SERVICE_NAMES,
  SERVICE_TOKEN_AUDIENCES,
  SERVICE_TOKEN_ISSUER,
  type IssuedServiceToken,
  type ServiceAudience,
  type ServiceName,
  type ServiceTokenClaims,
  type ServiceTokenConfig,
  type ServiceTokenRejection,
  type ServiceTokenSigner,
  type ServiceTokenVerdict,
  type SignServiceTokenInput,
} from './service-token.js';
