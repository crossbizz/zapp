/**
 * Barrel over the per-domain schema modules. `createDb` passes this namespace
 * to Drizzle, so anything exported here is queryable through the client; import
 * the domain module directly when you only need one table.
 */
export * from './identity.js'; // PRD §23.1
export * from './billing.js'; // PRD §23.1
export * from './projects.js'; // PRD §23.2
export * from './planning.js'; // PRD §23.3
export * from './execution.js'; // PRD §23.4
export * from './releases.js'; // PRD §23.5
export * from './security.js'; // PRD §23.6
export * from './incidents.js'; // OPS-11 operational diagnosis
export * from './lifecycle.js'; // CP-17 retention and verified deletion state
