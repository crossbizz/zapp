import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  PERMISSION_SETTINGS,
  ROLES,
  can,
  type Action,
  type Role,
} from '../src/policy/permissions.js';

/**
 * PRD §22.2, transcribed rather than imported.
 *
 * This table is a copy of the PRD's on purpose: a test that derived its
 * expectations from `src/policy/permissions.ts` would pass for any matrix at
 * all, including a wrong one. The capability names are the PRD's wording, the
 * cells are its literal values, and the order is its order — so a diff against
 * the document is a diff against this array.
 *
 * | Capability | Owner | Builder | Viewer |
 * |---|---:|---:|---:|
 * | Manage organization | Yes | No | No |
 * | Manage billing | Yes | No | No |
 * | Manage members | Yes | No | No |
 * | Create project | Yes | Yes | No |
 * | Edit code | Yes | Yes | No |
 * | Start agent run | Yes | Yes | No |
 * | Approve production deploy | Yes | Configurable | No |
 * | View project | Yes | Yes | Yes |
 * | View secrets metadata | Yes | Yes | No |
 * | Read secret values | No through UI | No through UI | No |
 */

type Cell = 'Yes' | 'No' | 'Configurable';

interface Row {
  readonly capability: string;
  readonly action: Action;
  readonly owner: Cell;
  readonly builder: Cell;
  readonly viewer: Cell;
}

const PRD_MATRIX: readonly Row[] = [
  {
    capability: 'Manage organization',
    action: 'manage_organization',
    owner: 'Yes',
    builder: 'No',
    viewer: 'No',
  },
  {
    capability: 'Manage billing',
    action: 'manage_billing',
    owner: 'Yes',
    builder: 'No',
    viewer: 'No',
  },
  {
    capability: 'Manage members',
    action: 'manage_members',
    owner: 'Yes',
    builder: 'No',
    viewer: 'No',
  },
  {
    capability: 'Create project',
    action: 'create_project',
    owner: 'Yes',
    builder: 'Yes',
    viewer: 'No',
  },
  { capability: 'Edit code', action: 'edit_code', owner: 'Yes', builder: 'Yes', viewer: 'No' },
  {
    capability: 'Start agent run',
    action: 'start_run',
    owner: 'Yes',
    builder: 'Yes',
    viewer: 'No',
  },
  {
    capability: 'Approve production deploy',
    action: 'approve_production_deploy',
    owner: 'Yes',
    builder: 'Configurable',
    viewer: 'No',
  },
  {
    capability: 'View project',
    action: 'view_project',
    owner: 'Yes',
    builder: 'Yes',
    viewer: 'Yes',
  },
  {
    capability: 'View secrets metadata',
    action: 'view_secret_metadata',
    owner: 'Yes',
    builder: 'Yes',
    viewer: 'No',
  },
];

/** The PRD's last row has no action at all — see the `read secret values` suite below. */
const SECRET_VALUE_ACTION = 'read_secret_value' as Action;

function cellOf(row: Row, role: Role): Cell {
  switch (role) {
    case 'owner':
      return row.owner;
    case 'builder':
      return row.builder;
    case 'viewer':
      return row.viewer;
  }
}

describe('PRD §22.2 permission matrix', () => {
  it('covers exactly the nine capabilities the matrix names', () => {
    expect([...ACTIONS]).toEqual(PRD_MATRIX.map((row) => row.action));
    expect([...ROLES]).toEqual(['owner', 'builder', 'viewer']);
  });

  // 27 cells, one assertion each: `Configurable` is asserted in both of its
  // states, so no cell is left to a default.
  for (const row of PRD_MATRIX) {
    for (const role of ROLES) {
      const cell = cellOf(row, role);

      if (cell === 'Configurable') {
        it(`${row.capability}: ${role} = Configurable`, () => {
          expect(can(role, row.action, { builderCanDeploy: true })).toBe(true);
          expect(can(role, row.action, { builderCanDeploy: false })).toBe(false);
          // Absent setting is the off position: a permission the organization
          // has not granted is not one it has.
          expect(can(role, row.action)).toBe(false);
        });
        continue;
      }

      it(`${row.capability}: ${role} = ${cell}`, () => {
        const allowed = cell === 'Yes';
        expect(can(role, row.action)).toBe(allowed);
        // The setting exists for one cell only; it must not widen or narrow
        // any other. This is what stops a future `ctx` flag from leaking.
        expect(can(role, row.action, { builderCanDeploy: true })).toBe(allowed);
        expect(can(role, row.action, { builderCanDeploy: false })).toBe(allowed);
      });
    }
  }
});

describe('the Configurable cell', () => {
  it('is governed by a setting it names, not by "configurable" in general', () => {
    // The matrix spells its one `Configurable` cell as *which* setting decides
    // it. That is what keeps a second configurable capability, whenever one
    // lands, from inheriting `builderCanDeploy` — a Builder allowed to approve
    // production deploys silently acquiring an unrelated new power is not a
    // decision anybody would have made on purpose (plan 02 CP-3 review).
    expect([...PERMISSION_SETTINGS]).toEqual(['builderCanDeploy']);
    // And an unknown setting fails closed, like every other unknown here.
    expect(can('builder', 'approve_production_deploy', { notASetting: true } as never)).toBe(false);
  });
});

describe('read secret values (PRD §22.2 last row)', () => {
  it('is not an action any role can ask for', () => {
    // "No through UI" for Owner and Builder, "No" for Viewer: the matrix grants
    // it to nobody, so the safest encoding is no action at all. `can` is what a
    // route calls, and a route cannot spell a capability that does not exist.
    expect(ACTIONS).not.toContain(SECRET_VALUE_ACTION);
    for (const role of ROLES) {
      expect(can(role, SECRET_VALUE_ACTION)).toBe(false);
      expect(can(role, SECRET_VALUE_ACTION, { builderCanDeploy: true })).toBe(false);
    }
  });
});

describe('can()', () => {
  it('denies an action it does not recognise', () => {
    for (const role of ROLES) {
      expect(can(role, 'delete_everything' as Action)).toBe(false);
    }
  });

  it('denies a role it does not recognise', () => {
    // Roles arrive from a database column. A value outside the enum — a bad
    // migration, a hand-edited row — must fail closed rather than fall through
    // to a default branch that happens to allow something.
    for (const action of ACTIONS) {
      expect(can('admin' as Role, action, { builderCanDeploy: true })).toBe(false);
      expect(can('' as Role, action)).toBe(false);
    }
  });
});
