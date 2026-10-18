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

## Work Guidance

- Preserve the existing local fixtures while adding independent applications.
- Keep external benchmark source and data outside the ActiveTab checkout unless the user explicitly requests vendoring.
- Use exact, reviewed modifications for external bind-address changes; never expose an external fixture server beyond loopback.
- Keep fixture setup, driver execution, oracle scoring, and cleanup independently reportable.

## Verification

```bash
node --test test/fixture-lab.test.js test/qualification.test.js
```

Run an external benchmark only against its pinned local synthetic application. It must not access staging or production.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `adapters/` | External independently maintained application targets |
| `catalog/` | Versioned reproducible qualification scenarios |
| `fixtures/` | Self-hosted stateful application twins |
| `runtime/` | Provider, scenario, driver, variant, and fault contracts |
| `scoring/` | Independent fixture outcome scoring |
