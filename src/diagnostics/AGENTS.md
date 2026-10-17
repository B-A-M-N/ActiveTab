# ActiveTab Diagnostics & Evidence

## Purpose

Owns diagnostic contracts, evidence collection, correlation, and reporting.

## Ownership

ActiveTab's diagnostic evidence plane. Browser instrumentation and privileged backend diagnostics remain distinct authorities.

## Local Contracts

- Diagnostic reads require declared authority, exact scope, bounded collection, and sensitivity controls.
- A broad administrative GET is not inherently safe.
- Empty responses are not automatically success; semantic status must be propagated into test outcomes.
- Correlation distinguishes exact, probable, temporal-only, and unavailable relationships.
- Backend loopback endpoints require explicit SSH-tunnel transport and verified remote target identity.
- No credentials, cookies, session tokens, or raw conversation content are forwarded to a planner by default.

## Work Guidance

- Each diagnostic source declares its contract; use typed outcomes, not exceptions alone.
- Enforce byte limits while streaming, not after reading the full response.
- Browser evidence and backend evidence must remain distinguishable.
- Never present a temporal match as exact correlation.

## Verification

```bash
node --test test/diagnostics.test.js test/cloudAgentAdapter.test.js
```

Cloud Agent adapter tests use an isolated loopback fixture and require explicit transport configuration.

## Child DOX Index

No child DOX boundaries.
