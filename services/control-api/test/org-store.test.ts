import { newId } from '@zapp/contracts';

import { InMemoryOrganizationStore } from './support/org-store.js';
import { describeOrganizationStore } from './support/store-contract.js';

/**
 * The double, held to the same contract as the shipping store — see
 * `test/support/store-contract.ts`. `test/integration/orgs.test.ts` runs the
 * identical suite against PostgreSQL.
 */
describeOrganizationStore('in-memory double', () =>
  Promise.resolve({
    store: new InMemoryOrganizationStore(),
    // No users table to satisfy: an id of the right shape is the whole of what
    // this implementation needs.
    createUser: () => Promise.resolve(newId('user')),
  }),
);
