# Workflow Step Handlers

## Purpose

Own step-specific workflow behavior separated from the top-level runner.

## Ownership

The testing layer. `ControlFlowStepHandler` owns scoped variable assignment, bounded repetition, and registered subworkflow composition. `VerificationStepHandler` owns evidence assertions, diagnostic snapshot handling, and cleanup verification. `TestRunner` owns the parent run, scheduling, receipts, cancellation, and dispatch of ordinary steps.

## Local Contracts

- Control-flow handlers have no browser session, application adapter, authorization grant, or direct effect executor.
- Nested execution is requested only through the injected `TestRunner` workflow-step callback, preserving the parent's run identity, budget, receipt, cancellation, and execution authority.
- Variables remain scoped and scalar; subworkflow definitions come only from the trusted registry and retain schema, depth, cycle, and declared-input/output checks.
- Repetition remains bounded, checks cancellation between iterations, and does not retry after uncertain or non-PASS body results.
- Verification handlers can observe and assert evidence but cannot label a dispatched effect successful without the declared assertion; cleanup dispatch re-enters the runner's authorized API or interaction handlers.
- Preserve the existing receipt vocabulary, step identifiers, and checkpoint ordering.

## Verification

```bash
node --test test/testing.test.js test/diagnostics.test.js test/goal-steps.test.js test/workflow-scheduler.test.js test/authorized-executor.test.js
```

No child DOX boundaries.
