/**
 * Barrel over the per-domain schema modules. `createDb` passes this namespace
 * to Drizzle, so anything exported here is queryable through the client; import
 * the domain module directly when you only need one table.
 */
export * from './identity.js';
export * from './billing.js';
