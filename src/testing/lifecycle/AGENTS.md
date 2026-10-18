# Workflow Run Lifecycle

## Purpose

Own durable run bindings, execution and browser-target leases, step checkpoints, run-state completion, and human-intervention continuation.

## Ownership

The testing layer. `RunStateCoordinator` owns persistence and execution-lease lifecycle for a workflow run. `InterventionCoordinator` owns durable human handoffs, resume ownership, completion-predicate evaluation, and continuation from the suspended step. `TestRunner` remains the top-level workflow coordinator and wires these services to the same workflow execution callbacks.

## Local Contracts

- Bind durable state to the exact workflow version/hash, environment, target, principal, profile, and policy before execution.
- Acquire the run lease and exact browser-target lease before execution; preserve target fencing tokens on reservations and refuse dispatch after lease loss.
- Persist step outcomes before advancing. If checkpoint persistence fails after an effect, mark that step uncertain and require reconciliation.
- Preserve waiting and uncertain run states as resumable/reconciliation states rather than converting them to terminal failures.
- Persist the intervention before returning control. Resume must reacquire execution ownership, evaluate fresh completion evidence, and rebind the exact workflow/environment/target/principal/policy before continuation.
- Continue through the existing runner callback and shared execution budget; an intervention coordinator cannot authorize or dispatch browser/application effects.
- `RunStateCoordinator` coordinates state only. `InterventionCoordinator` evaluates only the declared human-handoff completion predicate; neither service authorizes or dispatches browser/application effects.

## Verification

```bash
node --test test/runStateCoordinator.test.js test/runState.test.js test/interventions.test.js test/goal-steps.test.js test/testing.test.js
```

No child DOX boundaries.
