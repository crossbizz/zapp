# Private-beta operations

The V-5 operations kit reserves five anonymous agency aliases, defines
severity-based support targets and two-person rotations, and moves coded
feedback into `tasks/beta-feedback.md` without committing participant identity
or raw customer text.

Validate the kit and inspect current readiness:

```sh
pnpm validation:beta-policy
```

Require actual onboarding readiness in a gate:

```sh
node validation/beta/validate.mjs --require-ready
```

The second command exits `2` until 3–5 agencies are active, each active agency
has onboarding evidence and task-linked feedback, and a two-person support
rotation is assigned. The checked-in templates intentionally remain blocked
until real private-beta participation exists.
