/**
 * PRD §22.2, as code.
 *
 * One table, consulted by every route that mutates anything. It is written out
 * cell by cell rather than derived from role *levels* on purpose: roles here are
 * not ordered — "view secrets metadata" is denied to a Viewer but granted to a
 * Builder, while "manage members" is denied to both — and a `role >= builder`
 * shortcut is exactly how a matrix drifts from the document that defines it.
 *
 * The set of capabilities is closed. A route that needs a permission this table
 * does not name is a PRD change first and a code change second, which is why
 * {@link can} denies an action it does not recognise instead of defaulting.
 */

/** PRD §22.2 P0 roles, in the matrix's column order. */
export const ROLES = ['owner', 'builder', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

/** PRD §22.2 capabilities, in the matrix's row order. */
export const ACTIONS = [
  'manage_organization',
  'manage_billing',
  'manage_members',
  'create_project',
  'edit_code',
  'start_run',
  'approve_production_deploy',
  'view_project',
  'view_secret_metadata',
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * What the matrix says about one capability for one role.
 *
 * `'configurable'` is the PRD's own third value, and it is a third value rather
 * than a `true` with a footnote because the answer genuinely depends on an
 * organization setting — encoding it as either boolean would make the table lie
 * about half the deployments.
 */
type Grant = boolean | 'configurable';

/**
 * The one PRD §22.2 cell that is not a constant.
 *
 * Optional, and absent means denied: an organization that has never made the
 * decision has not made it in favour. CP-6 stores the setting on the
 * organization; until then the only caller passing it is a test, which is
 * enough to pin both halves of the cell.
 */
export interface PermissionContext {
  /** PRD §22.2 "Approve production deploy: Builder = Configurable". */
  readonly builderCanDeploy?: boolean;
}

/**
 * PRD §22.2 verbatim. `satisfies` pins full membership in both directions: a new
 * role or action that is not given a cell here fails to compile, and a cell for
 * something the PRD does not name fails too.
 *
 * The PRD's tenth row — "Read secret values: No through UI" for every role — is
 * deliberately absent. Granting it to nobody and *naming* it would leave a
 * capability a future route could ask for and a future edit could flip to
 * `true`; leaving it out means a secret value has no permission to read it at
 * all. Reading one is an audited vault operation (PRD §18.12, plan 02 CP-7),
 * never a role check.
 */
const MATRIX = {
  owner: {
    manage_organization: true,
    manage_billing: true,
    manage_members: true,
    create_project: true,
    edit_code: true,
    start_run: true,
    approve_production_deploy: true,
    view_project: true,
    view_secret_metadata: true,
  },
  builder: {
    manage_organization: false,
    manage_billing: false,
    manage_members: false,
    create_project: true,
    edit_code: true,
    start_run: true,
    approve_production_deploy: 'configurable',
    view_project: true,
    view_secret_metadata: true,
  },
  viewer: {
    manage_organization: false,
    manage_billing: false,
    manage_members: false,
    create_project: false,
    edit_code: false,
    start_run: false,
    approve_production_deploy: false,
    view_project: true,
    view_secret_metadata: false,
  },
} as const satisfies Record<Role, Record<Action, Grant>>;

/**
 * The same table, widened to `string` keys.
 *
 * Deliberate: the types say `role` is a `Role` and `action` an `Action`, but
 * `role` arrives from a database column and `action` from a call site that may
 * have been refactored. Widening is what lets {@link can} *ask* whether the
 * value is in the table instead of assuming it, and what makes the miss a
 * denial rather than an `undefined` flowing onward.
 */
const GRANTS: Record<string, Record<string, Grant | undefined> | undefined> = MATRIX;

/**
 * Whether `role` may perform `action` — the only question a route asks about
 * authorization.
 *
 * Fails closed on both axes: a value outside either enum (a bad migration, a
 * hand-edited row, a typo that survived a refactor) denies rather than landing
 * on a default branch.
 */
export function can(role: Role, action: Action, context: PermissionContext = {}): boolean {
  const grant = GRANTS[role]?.[action];
  if (grant === undefined) {
    return false;
  }
  return grant === 'configurable' ? context.builderCanDeploy === true : grant;
}
