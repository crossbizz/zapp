# ADR-0026 — Verification binaries are baked into immutable workspace images

**Status:** Accepted (controller-delegated execution, 2026-08-09)

## Context

VF-5 requires every release candidate to run Gitleaks in its fresh gate workspace. The
current immutable `forge-node-base` image does not contain that binary, and verification
workspaces have restricted networking and install nothing at runtime. A mocked process can
test parsing but cannot prove that the production image can execute the gate. Persisting raw
command output is also unsafe unless the evidence boundary structurally redacts every
registered secret.

The existing VF-5 Files list covers only gate modules and their unit test. It excludes the
image recipe, the publisher smoke, and the gate registry contract needed to make those two
requirements production properties.

## Decision

VF-5 also owns the narrow verification-image and artifact-boundary changes required by its
acceptance:

- `forge-node-base` downloads Gitleaks 8.26.0 from its official release, verifies the exact
  Linux x64 SHA-256 from the official checksum manifest, installs it at build time, and
  proves the version before the layer can complete. The version and checksum live in
  `infra/modal/image-config.json`.
- The existing one-shot image publisher smoke creates a temporary Git repository, plants a
  runtime-assembled test credential, scans exactly `base..head`, requires file-and-line
  evidence, and proves the report does not contain the planted value.
- Gate contexts accept only a branded evidence sink created by
  `createRedactingArtifactSink`. The wrapper applies the caller's registered-secret
  redactor before delegating any bytes to durable storage. Secret-scan artifacts additionally
  omit upstream `Secret` and `Match` fields.
- VF-5 publishes one new immutable dev image only at final acceptance and records its exact
  source, tag, and digests in `images.lock.json`. No review round calls Modal or downloads a
  runtime tool.

## Consequences

- The image grows by one checksum-pinned maintained OSS binary; there is no custom secret
  analyzer and no runtime network dependency.
- Later verification tasks consume the new lock record without rebuilding it.
- Adding another mandatory gate executable requires the same configuration, checksum,
  recipe test, and real publisher-smoke proof; a mocked executable alone is insufficient.
- This amendment does not broaden Gitleaks into a containment mechanism. It is a release
  evidence gate under ADR-0016/0017's severity rules.
