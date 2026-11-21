# Workflow Run Lifecycle

## Purpose

Own durable run bindings, owner-private JSON run documents, execution and browser-target leases, step checkpoints, run-state completion, and human-intervention continuation.

## Ownership

The testing layer. `RunStateCoordinator` owns run bindings and execution-lease lifecycle for a workflow run. `RunStateStore` owns the public run-state API and delegates owner-private JSON document initialization, reads, and atomic replacement to `RunDocumentStore`; it delegates SQLite browser-target lease storage to `BrowserTargetLeaseStore`, which owns fencing-token allocation and lease renewal mechanics. `InterventionCoordinator` owns durable human handoffs, resume ownership, completion-predicate evaluation, and continuation from the suspended step. `TestRunner` remains the top-level workflow coordinator and wires these services to the same workflow execution callbacks.

## Local Contracts

- Bind durable state to the exact workflow version/hash, environment, target, principal, profile, and policy before execution.
- A trusted host may declare the workflow's profile-bound authentication realm when one run visibly crosses application realms. Keep that realm immutable across restart; every dispatched step still derives its application identity from the live observed URL and passes normal policy admission.
- Acquire the run lease and exact browser-target lease before execution; preserve target fencing tokens on reservations and refuse dispatch after lease loss.
- A navigation recovery may validate the durable target-lease token while its original CDP session is detached, then rebind only an attached replacement with the exact endpoint and target identity. Rebinding retains the same fencing token; dispatch still requires a current attached session.
- Persist step outcomes before advancing. If checkpoint persistence fails after an effect, mark that step uncertain and require reconciliation.
- Preserve waiting and uncertain run states as resumable/reconciliation states rather than converting them to terminal failures.
- Persist the intervention before returning control. Resume must reacquire execution ownership, evaluate fresh completion evidence, and rebind the exact workflow/environment/target/principal/policy before continuation.
- Continue through the existing runner callback and shared execution budget; an intervention coordinator cannot authorize or dispatch browser/application effects.
- `RunStateCoordinator` coordinates state only. `InterventionCoordinator` evaluates only the declared human-handoff completion predicate; neither service authorizes or dispatches browser/application effects.
- `RunDocumentStore` owns JSON run-document path validation, owner-private root setup, the fixed 64 KiB write bound, and atomic replacement. It does not decide operation transitions, grant leases, or authorize browser effects.
- `RunDocumentStore.writeAtomic()` exposes an optional `beforeRename` cut point only for tests that terminate a child process between durable temporary-file sync and replacement. Production callers omit it; restart ignores the orphaned temporary file and reads the last renamed document.

## Verification

```bash
node --test test/runStateCoordinator.test.js test/runState.test.js test/interventions.test.js test/goal-steps.test.js test/testing.test.js
```

## Child DOX Index

| Path | Purpose |
|------|---------|
| `runDocumentStore.js` | Owner-private JSON run-document reads and atomic replacement |
