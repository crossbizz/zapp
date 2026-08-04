# 0000 — Template

<!--
Copy this file to `docs/adr/NNNN-short-kebab-title.md`, using the next free number.
Numbers are never reused and files are never deleted: an ADR that stops being true is
marked `superseded by NNNN`, not edited away. The history is the point.

Write an ADR when a choice is expensive to reverse, when two reasonable engineers would
pick differently, or when a decision contradicts something already written down (a PRD
section, a plan, or an earlier ADR). Do not write one for a choice the code already
makes obvious.

Delete these comments in the copy.
-->

Status: proposed <!-- proposed | accepted (who, YYYY-MM-DD) | superseded by NNNN -->
Affects: <!-- the paths, packages and plan tasks this constrains -->
References: <!-- PRD §N, plan NN task XX-N, related ADRs -->

## Context

The forces in play, in the present tense: what is true today, what constraint or
conflict surfaced, and why the status quo does not survive it. State facts a reader can
check, not conclusions. If a PRD section or an earlier ADR is being contradicted, say so
here and quote it.

## Decision

What was decided, in the active voice: "contracts ship the PRD §18.2 method set
verbatim". One decision per ADR. Include the alternatives that were seriously
considered and the reason each lost — an ADR that lists no rejected option is a note,
not a decision record.

## Consequences

What follows, good and bad: what becomes easy, what becomes harder, what work this
creates, and what has to change if the decision is later reversed. Name the exit
condition where one exists ("revisit at the M3 gate"). Deviating from an accepted ADR
requires a new ADR that supersedes it.
