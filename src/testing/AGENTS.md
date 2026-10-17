# ActiveTab Testing & Verification

## Purpose

Owns declarative workflow schemas, test execution, receipts, assertions, and postcondition verification.

## Ownership

ActiveTab's testing layer. It dispatches through the authorized executor and browser session; it does not own policy decisions.

## Local Contracts

- Dispatch, observed effects, and verified postconditions are separate states.
- Only an independent verified postcondition may report PASS.
- A page fingerprint change alone is not outcome success.
- Cleanup is a verifiable obligation for every test-owned resource.
- Every interaction type in the schema must have a dispatch implementation or fail validation before execution.
- Unsupported actions fail validation before the test starts.
- Workflow input is untrusted; it cannot elevate permissions or redefine the environment.

## Work Guidance

- Use the centralized authorized executor for all browser dispatch.
- Never dispatch directly through `session.client.send()` for effectful operations.
- When authorization changes, test the same action through every entrypoint: navigation engine, test runner, HTTP API, MCP, and workflow replay.
- A test-owned resource must be created and identified durably before cleanup verification is meaningful.
- Staging qualification begins at the profile's real application entry and follows visible navigation to Cloud Agent; a profile candidate URL is an identity hint and never an automatic destination.
- Authentication handoff keeps the same run and browser alive until fresh evidence verifies the Cloud Agent task composer.
- Owned browser profiles and qualification run state persist independently. Restart resume requires the explicit run ID, matching profile/mode/environment, the same owned profile or exact attached target, and fresh Cloud Agent task-composer evidence. A verified authentication predicate completes the suspended visible-entry step without replaying it.
- Qualification run-state cursors contain bounded step/intervention references only; they omit raw goals and browser evidence. Unfinished runs block replacement runs until explicitly resumed or marked abandoned.
- Ordinary qualification only inventories visible diagnostic links. The separate Admin discovery entrypoint is profile-driven and may follow an exact visible same-origin Admin link, inspect one row disclosure, and restore its state. It remains separate from Cloud Agent task execution and never creates a task.
- Main account-dashboard discovery requires the exact profile-declared `/dashboard` route and inventories visible model labels plus exact Agents, Settings, and Admin Console link destinations. This recipe does not follow those links or read form values, response bodies, or infer Cloud Agent task-selector choices from the account catalog. Admin Console content is handled only through a separate operator-directed walkthrough.
- The main account Admin Console inventory runs only after the operator has opened the exact profile-declared Users route. It records allowlisted view-control labels, filter option labels, and spend/request/token table column labels only; it excludes summary-card values, user rows, field values, and response bodies, and never changes filters or submits actions. A separate incident-scoped flow may collect a specific user's spending evidence after the target and time window are explicit.
- The operator has designated the `Clear Last Hours` control under Admin Console / Recent Requests as permanently prohibited. Never click or submit it, even when a caller goal requests it; its effect has not been independently verified.
- The operator reports that Recent Requests supports filtered JSONL downloads for different time periods. Inventory filter and time-period choices without exporting. Treat JSONL as request-level sensitive; export only for an explicitly scoped incident and with the required FreeInference authorization.
- The operator reports that Admin Console → Overview → Providers has Overview and Performance subtabs, with dropdowns and a filter text field on Performance. Inventory labels and choices only; do not type or change selections. `Manage`, `Edit`, `Add`, and `Delete Keys` are prohibited controls in the Providers surface.
- Audit Log purpose is unknown and the operator prohibited interaction. Do not open that surface or use its dropdowns; preserve its controls as unknown without probing.
- The Cloud Agent Admin Audit page is separate from the account Admin Console Audit Log. The former has its own operator-directed category recipe; the latter is prohibited and its route is blocked from direct navigation.
- Admin Console Settings and Config may be inventoried read-only after the operator opens the exact surface. Use `discover:staging-admin-config` to record visible control labels and non-sensitive current values, redact secrets, and do not operate controls or change settings without explicit FreeInference authorization.
- Admin inventory reports include control names and native select choices, checkbox/switch state, table headers and row counts, and same-origin GET route shapes. They omit free-text field values, table cells, response bodies, and query strings; they do not submit forms, modify settings, or query database tables.
- Staging qualification does not create Agent jobs or mutate admin resources. Such operations require a separately scoped PR test request.

## Verification

```bash
node --test test/testing.test.js test/goal-steps.test.js test/qualifyCloudAgent.test.js test/qualifyTarget.test.js test/staging-admin-discovery.test.js test/e2e-vertical.test.js
```

E2E vertical tests require a real Chrome environment and fixture server.

## Child DOX Index

No child DOX boundaries.
