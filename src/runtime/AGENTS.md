# ActiveTab Runtime Policy & Approvals

## Purpose

Owns policy admission, authorization grants, and the centralized execution boundary for effectful browser and application operations.

## Ownership

ActiveTab's authorization architecture. Changes here affect every execution entrypoint and must be treated as security-critical.

## Local Contracts

- No effectful operation bypasses the authorized executor or action policy.
- Grants cannot be self-issued; the trusted issuer is configured at construction, not caller-supplied.
- Grant verification rejects omissions of required scope fields; unknown effects fail closed.
- Single-use grants are consumed atomically; reusable grants are not consumed on first use.
- Uncertain outcomes must be reconciled before retry.
- A Jev `needs_agent_review` disposition blocks dispatch before side effects. A positive Jev result never grants authority; reviewer unavailability may use deterministic local policy fallback.
- Production and staging authority are never interchangeable.
- Operator-prohibited control labels are hard-denied by both policy admission and the browser click dispatch boundary; caller intent cannot override them.
- The account Admin Console Audit Log is a no-touch surface: direct navigation, discovery navigation, and control interaction are refused. This does not apply to the separate Cloud Agent Admin Audit page.
- Settings and Config inspection is read-only. Mutating or operating their controls requires explicit FreeInference authorization; absent a scoped authorization capability, dispatch fails closed.
- Application-specific capabilities and operation contracts belong in profiles or adapters. Operator-defined hard denials may only reduce authority and are enforced here.
- A trusted operation authorizer injected by application composition may admit only operations covered by its exact registered contract. It cannot override operator hard denials or sensitive-action classifications, and workflow input cannot provide the authorizer.

## Work Guidance

- Changes to `approvals.js`, `authorizedExecutor.js`, or `interventions.js` require adversarial tests covering every execution entrypoint.
- Do not weaken grant verification to satisfy a fixture.
- A passing unit test does not prove cross-entrypoint safety; enumerate all entrypoints and demonstrate refusal before dispatch.

## Verification

```bash
node --test test/approvals.test.js test/authorized-executor.test.js test/goal-steps.test.js
```

Additional authorization changes require adversarial coverage across `run_goal`, `start_test_run`, HTTP API, direct navigation, and workflow replay.

## Child DOX Index

No child DOX boundaries.
