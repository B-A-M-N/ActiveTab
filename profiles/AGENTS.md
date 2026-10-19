# ActiveTab Profiles & Environment Identity

## Purpose

Owns application/environment profiles and the identity binding used by policy and qualification.

## Ownership

Environment identity definitions. Profiles propose identity; live verification establishes what is authorized.

## Local Contracts

- Profiles propose environment information; live identity verification establishes what is actually authorized.
- A profile's `authorized_origins` must include the application entry origin.
- Loopback is transport infrastructure, never the application being tested.
- Staging and production environment identities are never interchangeable.
- A redirect to an unauthorized origin must force re-evaluation, not silently inherit authority.

## Work Guidance

- Environment bindings are built through `buildEnvironmentBinding()` and verified through `verifyObservedUrl()`.
- Resolve live application identity through `resolveObservedApplication()` using the observed URL. Same-origin routes can belong to distinct applications and authentication realms; origin equality alone cannot select a profile application.
- Do not treat a configured URL as proof of backend identity.
- Application-specific capabilities belong in profiles or integration adapters, not generic runtime code.
- An application's optional `workflow_operations` may register lowercase `fill`, `select`, `toggle`, and `apply_filter` operation IDs. Registration binds capabilities to that exact verified application; it does not grant authority or bypass caller input references, policy admission, or the independent operation authorizer.
- Operator-reported hard denials are represented in the profile and may only reduce authority. Record their observed surface and source; do not infer a control's effect from its label.
- FreeInference account Admin Console Settings/Config inventory is read-only and only runs on an operator-opened route. Record visible controls and non-sensitive values; redact sensitive values and do not infer unseen routes.
- The account Admin Console Audit Log is a hard no-touch surface. Keep it distinct from the Cloud Agent application's separately inventoried Audit page.

## Verification

```bash
node --test test/environments.test.js
```

## Child DOX Index

No child DOX boundaries.
