# ActiveTab Qualification and Fixture Lab

## Purpose

Provides ActiveTab's integrated qualification and adaptation capability: reproducible site scenarios, isolated fixture providers, failure variations, independent oracles, and benchmark scoring.

## Ownership

This package is part of ActiveTab's capability surface. It owns benchmark orchestration and target adapters; ActiveTab's browser runtime remains the only automation controller.

## Local Contracts

- The driver receives only the target binding and public task. Fixture oracles remain in the provider and are queried after the driver finishes.
- Browser automation uses ActiveTab's native CDP execution path. Playwright is not an ActiveTab control or observation dependency.
- An owned Chrome qualification target receives a durable endpoint-and-target lease for the entire driver run. The authorized executor rechecks that lease before dispatch.
- External applications are separately installed qualification targets, never ActiveTab runtime dependencies.
- Every target must have an explicit environment binding, bounded execution, independent scoring, and cleanup verification.
- A fixture result may qualify a candidate strategy but cannot authorize a live target or substitute for live-site verification.
- Qualified strategies remain versioned candidates. Promotion, replay, and training export require their own explicit review and authorization.
- Scenario and fault variation is deterministic from a recorded seed. Unsupported variations fail validation.
- Fault-injection lifecycle tests use disposable owner-private state directories and real Node child processes against the production local SQLite/filesystem stores. The CDP postcondition cut point also uses `BrowserSession` and `TestRunner` against a disposable loopback Chrome target, kills the runner after dispatch while verification is pending, and reconciles against an independent fixture oracle. These tests do not qualify external applications.
- Every scenario declares a qualification level, provider identity, source revision, and oracle reference. Scenario and benchmark receipts persist those fields with the seed and cleanup result. `resolver` does not claim an independent application outcome; `integration` names owned-app browser/CDP coverage; `outcome` requires an independent application-state oracle. `live` requires separately scoped authorization and is not runnable through Fixture Lab.
- The built-in extraction qualifier is a deterministic in-process resolver baseline. It does not claim to exercise an independently maintained application; external benchmark targets remain in scope and must be selected through their registered Fixture Lab adapters and independent oracles.
- API response-shape qualification is limited to completed same-origin GET JSON requests already observed from the page. The selected response is interpreted locally; the provider-side `api-shape-twin` oracle scores only schema, record completeness, and credential-value isolation across seeded variants. This does not register an API, replay a request, or authorize an effect.

## Work Guidance

- Preserve the existing local fixtures while adding independent applications.
- Keep external benchmark source and data outside the ActiveTab checkout unless the user explicitly requests vendoring.
- Use exact, reviewed modifications for external bind-address changes; never expose an external fixture server beyond loopback.
- WebArena-Infinity setup uses a disposable pinned checkout. Its UI seed adapter may provide only bounded synthetic scenario rows to the page; preserve pre-existing modified checkouts and never surface the oracle credential to browser content.
- Keep fixture setup, driver execution, oracle scoring, and cleanup independently reportable.
- Always terminate child processes and remove disposable state in `finally` blocks, including when an assertion fails.

## Verification

```bash
node --test test/fi-agent-twin-auth.test.js test/fixture-lab.test.js test/qualification.test.js
node --test test/run-lifecycle-multiprocess.test.js
```

Run an external benchmark only against its pinned local synthetic application. It must not access staging or production.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `adapters/` | External independently maintained application targets |
| `catalog/` | Versioned reproducible qualification scenarios |
| `fixtures/` | Self-hosted stateful application twins |
| `fixtures/fi-agent-twin/frontend.js` | Escaped HTML rendering for the platform and Cloud Agent fixture surfaces |
| `fixtures/fi-agent-twin/auth.js` | Separate platform and Agent credentials, sessions, and realm-bound MFA challenges |
| `fixtures/fi-agent-twin/http.js` | Bounded request parsing, response serialization, cookie lookup, and loopback listener setup |
| `fixtures/fi-agent-twin/persistence.js` | Private SQLite fixture schema, audit insertion, and run-row projection |
| `fixtures/fi-agent-twin/agentJobs.js` | Synthetic run submission, status/diagnostic reads, state transitions, and timer cleanup |
| `runtime/` | Provider, scenario, driver, variant, and fault contracts |
| `scoring/` | Independent fixture outcome scoring |
| `fault-injection/` | Disposable cross-process run-lifecycle crash and fencing harnesses |
