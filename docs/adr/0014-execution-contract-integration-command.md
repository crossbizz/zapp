# ADR-0014: Integration commands in execution contracts

- Status: Accepted
- Date: 2026-08-06
- Owners: Foundation contracts / verification / agent runtime
- Approval: product-owner delegated controller decision, 2026-08-06
- Affects: FND-4, AR-4, VF-3
- References: PRD §16.1, §17.1–§17.3; Plans 01, 04, and 05

## Context

PRD §16.1 includes `run_integration_tests`, and the verification gate registry names
an `integration_tests` gate. The strict `ExecutionContractSchema.test` block exposed
only unit and browser commands, leaving the registered integration tool unable to
execute under any valid project contract.

Caller-supplied command aliases are not acceptable because named tools must run the
latest scanned and tenant-attributed project contract.

## Decision

Add optional `test.integration` to `ExecutionContractSchema`. The test block remains
strict and must contain at least one of `unit`, `browser`, or `integration`.

`run_integration_tests` reads the latest validated execution contract through the
project-data port and executes only `test.integration` from that contract. It returns
a truthful not-configured result only when that field is absent.

Capability scanning and project adapters may populate the field only from detected,
project-owned integration test configuration or scripts. They must not copy a command
from a tool caller.

## Consequences

- Existing execution contracts remain valid because the field is optional.
- Strict parsing continues to reject unknown test keys and an empty test block.
- Plan 05 can distinguish a known integration command from an unavailable integration
  gate without inventing a command at execution time.
