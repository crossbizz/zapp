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
 * The organization settings a `Configurable` cell may depend on, as a closed
 * set. One today; the list is what a new one is added to.
 */
export const PERMISSION_SETTINGS = ['builderCanDeploy'] as const;

export type PermissionSetting = (typeof PERMISSION_SETTINGS)[number];

/**
 * What the matrix says about one capability for one role.
 *
 * The PRD's third value, `Configurable`, is spelled as *which setting decides
 * it* rather than as a bare `'configurable'`. That is the difference between a
 * flag that governs one cell and a flag that governs every cell that happens to
 * be configurable: with a bare marker, adding a second configurable capability
 * silently puts it under `builderCanDeploy` — a Builder allowed to approve
 * production deploys would acquire the new capability too, which nobody
 * decided (plan 02 CP-3 review). Naming the setting makes that impossible to
 * express by accident.
 */
type Grant = boolean | PermissionSetting;

/**
 * The organization settings the PRD §22.2 `Configurable` cells depend on.
 *
 * Optional, and absent means denied: an organization that has never made the
 * decision has not made it in favour. CP-6 stores the setting on the
 * organization; until then the only caller passing it is a test, which is
 * enough to pin both halves of the cell.
 */
export type PermissionContext = Partial<Record<PermissionSetting, boolean>>;

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
    // PRD §22.2 "Approve production deploy: Builder = Configurable", and the
    // only cell in the table that is not a constant.
    approve_production_deploy: 'builderCanDeploy',
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

/** Whether `value` names a setting this service defines — not merely some string. */
function isSetting(value: string): value is PermissionSetting {
  return PERMISSION_SETTINGS.some((setting) => setting === value);
}

/**
 * Whether `role` may perform `action` — the only question a route asks about
 * authorization.
 *
 * Fails closed on every axis: a role or action outside its enum (a bad
 * migration, a hand-edited row, a typo that survived a refactor), and a cell
 * naming a setting that does not exist, all deny rather than landing on a
 * default branch that happens to allow something.
 */
export function can(role: Role, action: Action, context: PermissionContext = {}): boolean {
  const grant = GRANTS[role]?.[action];
  if (grant === undefined) {
    return false;
  }
  if (typeof grant === 'boolean') {
    return grant;
  }
  // The cell decides which setting governs it, so a setting can only ever widen
  // the one capability that named it.
  return isSetting(grant) && context[grant] === true;
}
