# Private-beta feedback tasks

This public tracker stores anonymous, coded feedback only. Participant names,
emails, raw quotes, customer data, and private URLs remain in the approved
external feedback system and are represented here only by an opaque
`feedback_*` reference.

Create an idempotent task from a validated record:

```sh
node validation/beta/record-feedback.mjs path/to/anonymous-record.json
```

## Queue

Each feedback item is atomically published as `tasks/beta-feedback/BETA-NNNN.md`.
