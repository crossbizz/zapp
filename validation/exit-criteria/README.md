# P0 exit-criteria evidence matrix

`manifest.json` maps every PRD section 39 criterion (E1–E22) to its owning
tasks, checked-in source evidence, reproducible verification commands, and
captured evidence artifacts.

States are intentionally strict:

- `candidate` means every required task is checked and the criterion is ready
  for an evidence run.
- `blocked` means at least one required task is unchecked and the blocker is
  recorded.
- `failed` means all owning tasks are checked but the recorded verification
  command failed; the exact defect is retained.
- `verified` requires both completed tasks and at least one checked-in evidence
  artifact. Source code or a tracker checkbox alone cannot produce this state.

Validate the matrix with:

```sh
pnpm validation:exit-criteria
```

The validator binds every entry to the exact PRD wording and the live
`tasks/todo.md` state, and rejects missing, duplicate, external, or symlinked
evidence paths. V-3 remains unchecked until every criterion is verified.
