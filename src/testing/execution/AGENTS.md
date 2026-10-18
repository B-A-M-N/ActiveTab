# ActiveTab Workflow Scheduling

## Purpose

Owns pure scheduling decisions for declarative workflows: graph admission, terminal status, trusted subworkflow validation, and expanded execution-budget calculation.

## Ownership

The testing layer. `TestRunner` owns run lifecycle, receipts, durable checkpoints, cancellation, and actual step dispatch.

## Local Contracts

- Scheduling decisions never authorize or dispatch browser or application effects.
- A scheduler result is advisory input to `TestRunner`; the runner records and checkpoints the selected status.
- Uncertain dependencies block ordinary effects and compensation until reconciliation rules permit continuation.
- Subworkflow execution is limited to trusted registered definitions and the parent run's shared step budget.
- Status and admission rules must preserve the existing `TestRunner` behavior and receipt vocabulary.

## Work Guidance

- Keep scheduling functions deterministic and free of I/O.
- Add direct unit coverage for changed admission or graph-status rules, plus runner-level workflow coverage.
- Leave policy admission and effect execution in their existing authoritative components.

## Verification

```bash
node --test test/workflow-scheduler.test.js test/testing.test.js test/workflows.test.js
```

## Child DOX Index

No child DOX boundaries.
