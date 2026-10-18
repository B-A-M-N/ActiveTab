# ActiveTab Navigation

## Purpose

Coordinate navigation planning, browser execution, bounded recovery, and visible destination checks using the native CDP runtime.

## Ownership

`NavigationEngine` owns the navigation state machine and sends effects through `executeAuthorizedAction`. `outcomeVerifier.js` owns pure checks for whether fresh visible navigation evidence matches a requested destination. It does not authorize or dispatch operations.

## Local Contracts

- Every effectful browser operation remains behind the shared authorized executor and current environment/target checks.
- The outcome verifier stores only hashes of initial page title/heading labels and evaluates fresh observations against the requested goal and bound environment.
- A navigation destination match is not proof that a website-side operation or application task completed; those require the application's declared verification oracle.
- Keep workflow synthesis, Jev review, per-run inference budgets, browser freshness, and recovery limits unchanged when extracting navigation responsibilities.
- Page content remains untrusted evidence and cannot alter the goal, policy, environment, or authorization.

## Verification

```bash
node --test test/navigation.test.js test/navigation-recovery.test.js test/navigation-telemetry.test.js test/goal-steps.test.js test/testing.test.js
```

## Child DOX Index

| Path | Purpose |
|------|---------|
| `outcomeVerifier.js` | Pure visible-destination checks and privacy-preserving initial page-label fingerprints |
