# ActiveTab Runtime Policy & Approvals

## Purpose

Owns policy admission, authorization grants, and the centralized execution boundary for effectful browser and application operations.

## Ownership

ActiveTab's authorization architecture. Changes here affect every execution entrypoint and must be treated as security-critical.

## Local Contracts

- No effectful operation bypasses the authorized executor or action policy.
- An attached browser target must have an active durable endpoint-and-target lease. The executor requires a lease assertion callback and checks it before reservation and again before browser dispatch.
- Composite browser operations declare an exact ordered suboperation envelope. Before each suboperation, the executor rechecks the target lease, page/application binding, fresh control identity, and trusted operation contract; an unlisted or out-of-order suboperation fails closed.
- Lease ownership is exclusive across local ActiveTab processes. Each takeover advances a fencing token; test-run reservations record the token so stale continuation state cannot authorize a new dispatch.
- Grants cannot be self-issued; the trusted issuer is configured at construction, not caller-supplied.
- Local file upload grants are disabled unless trusted runtime composition configures operator-owned allowed source roots (or the local `ACTIVETAB_UPLOAD_ALLOWED_ROOTS` setting). Roots must be canonical owner-controlled directories; source files must remain inside them, distinct from the private staging directory, and unchanged through staging and dispatch. Model/caller paths cannot widen the root set.
- Sensitive evidence-release grants are independently approved through the operator-authenticated local API. Each grant binds the exact principal, MCP process, target, retained evidence, profile/environment/application, facet and selectors, cumulative byte budget, and expiry; release rechecks the grant immediately before returning data. Raw response credentials require both a selected-body grant and a separate credential-value grant.
- Grant verification rejects omissions of required scope fields; unknown effects fail closed.
- Single-use grants are consumed atomically; reusable grants are not consumed on first use.
- Uncertain outcomes must be reconciled before retry.
- A Jev `needs_agent_review` disposition blocks dispatch before side effects. A positive Jev result never grants authority; reviewer unavailability may use deterministic local policy fallback.
- Production and staging authority are never interchangeable.
- Operator-prohibited control labels are hard-denied by both policy admission and the browser click dispatch boundary; caller intent cannot override them.
- Links declared to open a new browser target are refused by default. A trusted same-target navigation route must revalidate the exact observed link and destination, recheck the durable lease, and rerun the operation authorizer before dispatch; callers cannot adopt the newly opened target implicitly.
- The account Admin Console Audit Log is a no-touch surface: direct navigation, discovery navigation, and control interaction are refused. This does not apply to the separate Cloud Agent Admin Audit page.
- Settings and Config inspection is read-only. Mutating or operating their controls requires explicit FreeInference authorization; absent a scoped authorization capability, dispatch fails closed.
- Application-specific capabilities and operation contracts belong in profiles or adapters. Operator-defined hard denials may only reduce authority and are enforced here.
- A trusted operation authorizer injected by application composition may admit only operations covered by its exact registered contract. It cannot override operator hard denials or sensitive-action classifications, and workflow input cannot provide the authorizer.

## Work Guidance

- Changes to `approvals.js`, `authorizedExecutor.js`, or `interventions.js` require adversarial tests covering every execution entrypoint.
- Composite-action changes require a regression proving an unexpected second control and a changed page/application cannot receive a follow-up dispatch.
- Do not weaken grant verification to satisfy a fixture.
- A passing unit test does not prove cross-entrypoint safety; enumerate all entrypoints and demonstrate refusal before dispatch.

## Verification

```bash
node --test test/approvals.test.js test/authorized-executor.test.js test/goal-steps.test.js
```

Additional authorization changes require adversarial coverage across `run_goal`, `start_test_run`, HTTP API, direct navigation, and workflow replay.

## Child DOX Index

No child DOX boundaries.
