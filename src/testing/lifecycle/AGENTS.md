# Workflow Run Lifecycle

## Purpose

Own durable run bindings, execution and browser-target leases, step checkpoints, and run-state completion.

## Ownership

The testing layer. `RunStateCoordinator` owns persistence and lease lifecycle for a workflow run; `TestRunner` remains the top-level workflow coordinator and dispatch owner.

## Local Contracts

- Bind durable state to the exact workflow version/hash, environment, target, principal, profile, and policy before execution.
- Acquire the run lease and exact browser-target lease before execution; preserve target fencing tokens on reservations and refuse dispatch after lease loss.
- Persist step outcomes before advancing. If checkpoint persistence fails after an effect, mark that step uncertain and require reconciliation.
- Preserve waiting and uncertain run states as resumable/reconciliation states rather than converting them to terminal failures.
- This component coordinates run state only; it does not authorize, plan, verify, or dispatch browser/application effects.

## Verification

```bash
node --test test/runStateCoordinator.test.js test/runState.test.js test/testing.test.js
```

No child DOX boundaries.
