# Workflow Step Handlers

## Purpose

Own step-specific workflow behavior separated from the top-level runner.

## Ownership

The testing layer. `ControlFlowStepHandler` owns scoped variable assignment, bounded repetition, and registered subworkflow composition. `VerificationStepHandler` owns evidence assertions, diagnostic snapshot handling, and cleanup verification. `QualificationStepHandler` invokes the configured qualification subsystem and records its result. `BrowserStepHandler` owns navigation and interaction step behavior while all effectful browser operations pass through `executeAuthorizedAction`. `ApiStepHandler` dispatches registered typed diagnostic operations through the configured collector and preserves refusal, failure, and uncertainty in receipts. `ExtractionStepHandler` executes only registered read-only extraction contracts, accumulates per-field provenance, and routes pagination through the injected browser navigation handler. `goalOutcome.js` owns the pure mapping from navigation-engine results to workflow receipt status, preserving pre-dispatch cancellation separately from unresolved dispatched effects. `TestRunner` owns the parent run, scheduling, receipts, cancellation, and step dispatch.

## Local Contracts

- Control-flow handlers have no browser session, application adapter, authorization grant, or direct effect executor.
- Nested execution is requested only through the injected `TestRunner` workflow-step callback, preserving the parent's run identity, budget, receipt, cancellation, and execution authority.
- Variables remain scoped and scalar; subworkflow definitions come only from the trusted registry and retain schema, depth, cycle, and declared-input/output checks.
- Repetition remains bounded, checks cancellation between iterations, and does not retry after uncertain or non-PASS body results.
- Verification handlers can observe and assert evidence but cannot label a dispatched effect successful without the declared assertion; cleanup dispatch re-enters the runner's authorized API or interaction handlers.
- Qualification remains advisory unless the workflow explicitly requires it; fixture oracle results cannot authorize parent-run effects or replace live outcome verification.
- Browser step handlers may use fresh observation, wait, and value-verification APIs but must never dispatch directly through BrowserSession or CDP methods.
- Interact target selectors are resolved against a fresh observation. Profile-scoped entry selectors may constrain exact labels, link role, visibility, destination origin, and path; ambiguous, disabled, hidden, or mismatched candidates fail closed before dispatch.
- When an interaction declares both exact value verification and an application postcondition, both are independent requirements for PASS. A value mismatch or failed application postcondition is FAIL; unavailable evidence is UNCERTAIN.
- API step handlers may call only registered diagnostic sources through `DiagnosticCollector`; collected snapshots are evidence references, not proof of application outcome, and status classification must preserve refusal and uncertainty.
- Extraction handlers do not query arbitrary endpoints or evaluate page-supplied code. They use fresh retained DOM observations, enforce exact route and field policy, redact pagination query details from receipts, and mark partial collections incomplete on schema drift, ambiguous paging, route failure, cycles, or limits.
- Preserve the existing receipt vocabulary, step identifiers, and checkpoint ordering.

## Verification

```bash
node --test test/testing.test.js test/diagnostics.test.js test/goal-steps.test.js test/navigation-telemetry.test.js test/action-policy.test.js test/workflow-scheduler.test.js test/authorized-executor.test.js
```

No child DOX boundaries.
