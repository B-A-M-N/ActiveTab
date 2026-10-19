# Workflow Decision Telemetry

## Purpose

Translate declarative workflow run state into append-only decision telemetry and durable operation receipts.

## Ownership

The testing layer. `RunDecisionRecorder` links workflow operations to the shared decision runtime and run-state ledger; `TestRunner` remains the owner of workflow scheduling, receipts, cancellation, and step dispatch.

## Local Contracts

- Recording, reviewing, and persisting an operation never grants permission to dispatch it. The authorized executor and deterministic policy remain authoritative.
- Preserve stable episode, run, step, decision, operation, and observation identifiers across admission, reservation, dispatch, observation, and verification.
- Persist the durable operation reservation before effectful dispatch and retain the current target fencing token.
- Preserve uncertainty when dispatch or verification cannot be reconciled; never convert missing evidence into success.
- Keep telemetry projections bounded and exclude raw goals, form values, page text, credentials, cookies, and tokens.
- A Jev refusal or unavailable reviewer is handled by the decision runtime's advisory contract; recorder extraction must not change that behavior.
- Pre-action Jev routing requires a meaningful trusted target-role or purpose code plus image evidence bound to the exact observation. The recorder passes the caller-owned purpose code through when present; without sufficient evidence it records an explicit skip and leaves admission to deterministic policy.

## Verification

```bash
node --test test/navigation-telemetry.test.js test/testing.test.js test/authorized-executor.test.js
```

No child DOX boundaries.
