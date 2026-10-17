# ActiveTab Runtime Architecture

## Purpose

Native CDP runtime and navigation components for the ActiveTab browser automation platform.

## Ownership

ActiveTab's core execution layer. Contains the browser control plane, runtime policy boundary, testing engine, and diagnostic adapters.

## Local Contracts

- Effectful browser operations dispatch through `src/runtime/authorizedExecutor.js`, which applies policy admission before CDP dispatch.
- Browser sessions own freshness, target validity, and lifecycle checks; the authorized executor owns action policy.
- The extension broker's process/session shutdown is transport teardown, not consent revocation. It preserves the extension's explicit tab leases for same-browser-session reconnection; only an explicit detach releases a lease.
- Application-specific logic belongs in profiles or integration adapters, not in generic navigation, policy, or browser execution paths.
- All authorization boundaries are enforced by code, not documentation.

## Work Guidance

- When changing authorization behavior, run adversarial tests across every execution entrypoint.
- Read the nearest child DOX chain before editing a subtree.
- Do not weaken security checks to satisfy fixtures.

## Verification

```bash
node --test test/targets.test.js test/approvals.test.js test/authorized-executor.test.js test/goal-steps.test.js test/testing.test.js
```

## Child DOX Index

| Path | Purpose |
|------|---------|
| `src/browser/` | CDP transport, target authorization, and session lifecycle |
| `src/extension/` | Native Messaging broker and extension-backed CDP transport |
| `src/runtime/` | Policy, approvals, and execution boundary contracts |
| `src/testing/` | Declarative workflows, receipts, and verification semantics |
| `src/diagnostics/` | Diagnostic contracts, evidence collection, and correlation |
