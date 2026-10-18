# ActiveTab Workflow Execution Boundaries

## Purpose

Owns declarative workflow scheduling and validated type-to-handler dispatch. `workflowScheduler.js` contains pure graph admission, terminal status, trusted subworkflow validation, and expanded execution-budget decisions. `stepDispatcher.js` routes each validated step to its focused handler and preserves the runner's error receipt behavior.

## Ownership

The testing layer. `TestRunner` owns run lifecycle, receipts, durable checkpoints, and cancellation while coordinating the scheduler and dispatcher. `WorkflowScheduler` makes pure eligibility decisions. `StepDispatcher` routes typed steps only; it does not authorize or execute browser effects itself.

## Local Contracts

- Scheduling decisions never authorize or dispatch browser or application effects.
- A scheduler result is advisory input to `TestRunner`; the runner records and checkpoints the selected status.
- The dispatcher accepts only steps validated by the workflow schema and routes them to injected handlers. It does not make policy decisions or create an effect execution path.
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
