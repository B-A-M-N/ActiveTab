# ActiveTab Testing & Verification

## Purpose

Owns declarative workflow schemas, test execution, receipts, assertions, and postcondition verification.

## Ownership

ActiveTab's testing layer. It dispatches through the authorized executor and browser session; it does not own policy decisions.
`RunStateStore` owns the public run-state API and delegates SQLite browser-target lease persistence to `BrowserTargetLeaseStore`.

## Local Contracts

- Dispatch, observed effects, and verified postconditions are separate states. An unresolved dispatched effect yields run status `UNCERTAIN` until independent evidence reconciles it; it is not silently converted to `FAILED` or replayed.
- Durable operation reservations bind a run-scoped keyed fingerprint of the action, resource, and caller intent. Equivalent unresolved effects are refused across replanned step or operation IDs; raw intent values remain outside run records and telemetry.
- Cancellation is persisted in `RunStateStore` and remains available after a worker restart. Cancellation stops future dispatches while unresolved reserved/dispatched operations remain reconciliation obligations.
- A test run holds an exclusive durable lease for its exact browser endpoint and target ID. Continuation reacquires the target under a newer fencing token; operation reservations retain that token, and a competing run is refused before dispatch.
- A live session may be rebound to a replacement CDP session only when both exact target ID and canonical endpoint match the existing durable lease. Rebinding does not acquire a new lease or change its fencing token; a different target or endpoint is refused.
- During a detached-session recovery, `assertLeaseTokenCurrent()` checks durable ownership without requiring the old CDP session to remain attached. `bindSession()` may then rebind only an attached replacement with the original target ID and endpoint; effect dispatch continues to require `assertCurrent()` against the bound session.
- HTTP and MCP adapters create `TestRunner` instances through `ApplicationRunService`, which binds the shared browser diagnostic sources and durable `RunStateStore`; `TestRunner` remains responsible for acquiring and checking its workflow lease.
- Durable target leases use SQLite transactions across local processes. A lease held by a dead local process can be reclaimed immediately; expired leases are not taken over while their local owner process is still alive. Effects with lost leases are refused before dispatch and any earlier dispatch still requires reconciliation.
- `BrowserTargetLeaseStore` owns SQLite schema initialization, fencing-token allocation, heartbeat renewal, and release. `RunStateStore.acquireTargetLease()` remains the compatibility entrypoint.
- Diagnostic `api_call` receipts preserve typed refusal/error/unavailable statuses and explicitly record that collection alone did not verify an application outcome.
- Only an independent verified postcondition may report PASS.
- A `qualify` step runs the configured ActiveTab qualification subsystem against an isolated fixture or benchmark target. It never substitutes fixture evidence for the parent run's live-site verification. Qualification is advisory unless the workflow explicitly marks it required; unavailable or failed optional qualification does not block later steps.
- Qualification executes through a registered provider and the native CDP driver. Workflow input cannot supply provider code, a target binding, an oracle, or authorization. A qualified strategy is a versioned candidate only and cannot be replayed or promoted automatically.
- A page fingerprint change alone is not outcome success.
- Cleanup is a verifiable obligation for every test-owned resource.
- Every interaction type in the schema must have a dispatch implementation or fail validation before execution.
- `discover_tables`, `extract_records`, `collect_records`, and `emit_output` are read-only capability steps. They require a registered fixture-qualified manifest and fresh target/environment/principal/route scope. Declarative and synthesized collection share `collectionService.js`; each page advance re-enters the caller's browser navigation handler and authorized executor.
- Extraction values and accumulators are in-memory run artifacts. On continuation they are re-observed and rebuilt; missing artifacts after process restart produce an inconclusive result rather than a reconstructed PASS.
- `collect_records` obeys its registered page and row limits, verifies typed fields, uniqueness, provenance, and the declared count-completion policy, and never treats a dispatch acknowledgment as complete output.
- `execution/workflowScheduler.js` owns pure workflow eligibility, graph status, and trusted subworkflow budget validation. `execution/stepDispatcher.js` routes validated workflow steps to focused handlers. Neither component authorizes effects; browser effects remain behind the shared authorized executor.
- `lifecycle/RunStateCoordinator` owns durable run bindings, leases, checkpoints, and durable status; it cannot authorize or dispatch effects.
- `lifecycle/InterventionCoordinator` owns persisted human handoffs and evidence-gated resume while re-entering the same runner callback and shared execution budget.
- `qualificationRunSelection.js` owns durable staging-run selection, exact resume binding, and explicit abandonment before browser attachment. It validates workflow, environment, profile, mode, intervention cursor, and target identity; it does not connect to a browser.
- Intervention application identity is derived from the currently observed route through `resolveObservedApplication()` and the requested authentication realm; a realm-only first-match lookup cannot bind a handoff to an arbitrary same-origin application.
- `steps/ControlFlowStepHandler` owns scalar variable assignment, bounded repetition, and trusted subworkflow composition. Nested work re-enters the same `TestRunner` callback and shared budget.
- `steps/VerificationStepHandler` owns assertions, diagnostic snapshots, bounded waiting, controlled fixture failures, retry verification, postconditions, and cleanup verification. Cleanup dispatch is injected from `TestRunner` and must pass through the same authorized interaction path.
- `steps/QualificationStepHandler` invokes the registered qualification service and records its advisory result. Receipts preserve qualification level, provider identity, scenario seed, source revision, oracle reference, and cleanup result. Resolver results explicitly say that no independent application outcome was tested. Fixture outcomes never authorize parent-run effects or verify live-site success.
- `steps/BrowserStepHandler` owns declarative navigation and interaction behavior but sends every effect through `executeAuthorizedAction`; it records no alternate CDP dispatch path.
- `steps/ApiStepHandler` dispatches only registered typed diagnostic operations through the configured collector and records refusal, failure, and uncertain statuses without treating collection as outcome verification.
- `cloudAgentEntry.js` owns profile identity hints, visible-entry workflow construction, protected task-composer readiness evidence, and read-only visible diagnostic-link inventory. The profile candidate URL is never an automatic navigation target; inventory does not open links or inspect destinations.
- `telemetry/RunDecisionRecorder` owns the testing layer's mapping from workflow operations to decision events and durable operation receipts. It records but never authorizes or dispatches effects.
- Unsupported actions fail validation before the test starts.
- Workflow input is untrusted; it cannot elevate permissions or redefine the environment.
- A profile adapter may inject a process-local typed operation authorizer into `TestRunner`; serialized workflow fields alone never establish that authority.
- Exact form-value checks may return only a boolean verification result. Raw task values must stay out of receipts, task journals, and decision telemetry.
- A submitted Cloud Agent task remains `UNCERTAIN` until its run identifier is proven absent before submit, observed afterward on the same authorized tab, and matched to the exact scoped backend run record. Only an exact caller-requested run-status match may reconcile the task to PASS.

## Work Guidance

- Use the centralized authorized executor for all browser dispatch.
- Never dispatch directly through `session.client.send()` for effectful operations.
- When authorization changes, test the same action through every entrypoint: navigation engine, test runner, HTTP API, MCP, and workflow replay.
- When changing qualification contracts, cover optional refusal, required qualification, oracle isolation, cleanup failure, and telemetry linkage.
- Fixture Lab supports `resolver`, `integration`, and `outcome` qualification levels. A `live` level requires a separately authorized live-target runtime and is refused by the fixture runner.
- A test-owned resource must be created and identified durably before cleanup verification is meaningful.
- Staging qualification begins at the profile's real application entry and follows visible navigation to Cloud Agent; a profile candidate URL is an identity hint and never an automatic destination.
- Authentication handoff keeps the same run and browser alive until fresh evidence verifies the Cloud Agent task composer.
- An owned qualification browser remains open for operator authentication or inspection after any returned qualification state. The manual `--open-only` command releases its CDP connection and exits while leaving Chrome open; explicit operator closure controls browser lifetime.
- The staging qualification entrypoint shares the built-in decision telemetry runtime with declarative and navigation steps. Jev remains pinned and advisory; missing reviewer credentials are recorded without interrupting local browser operation.
- Jev review is event-driven: review task submissions, uncertain or privileged boundaries, navigation transitions, and other policy-selected events. Do not call Jev for ordinary exact-value field entry or selection without a trusted policy reason; append an explicit skipped-review telemetry event for such a step.
- A Jev `needs_agent_review` result pauses navigation, declarative interaction, direct observed-element actions, and discovery before dispatch. A positive Jev result never grants permission; deterministic policy remains authoritative.
- Owned browser profiles and qualification run state persist independently. Restart resume requires the explicit run ID, matching profile/mode/environment, the same owned profile or exact attached target, and fresh Cloud Agent task-composer evidence. A verified authentication predicate completes the suspended visible-entry step without replaying it.
- `--open-only` is a browser-lifecycle operation, not a qualification run. It must not read, create, or modify qualification run/intervention records. It may launch a new dedicated browser or reuse an already-running profile through CDP, but reuse must preserve the current page without navigation. The command exits with Chrome and its persistent profile still open. Resume and discard options are invalid in this mode; actual qualification keeps the unresolved-run guard.
- When the owned browser is already open, a fresh qualification requires the exact page target ID printed by `--open-only`; a suspended-run resume uses its persisted exact target ID. Reattachment validates the current origin, preserves the current page and browser process, and never substitutes another tab or reloads the staging entry.
- Qualification run-state cursors contain bounded step/intervention references only; they omit raw goals and browser evidence. Unfinished runs block replacement runs until explicitly resumed or marked abandoned.
- Ordinary qualification only inventories visible diagnostic links. The separate Admin discovery entrypoint is profile-driven and may follow an exact visible same-origin Admin link, inspect one row disclosure, and restore its state. It remains separate from Cloud Agent task execution and never creates a task.
- Main account-dashboard discovery requires the exact profile-declared `/dashboard` route and inventories visible model labels plus exact Agents, Settings, and Admin Console link destinations. This recipe does not follow those links or read form values, response bodies, or infer Cloud Agent task-selector choices from the account catalog. Admin Console content is handled only through a separate operator-directed walkthrough.
- The main account Admin Console inventory runs only after the operator has opened the exact profile-declared Users route. It records allowlisted view-control labels, filter option labels, and spend/request/token table column labels only; it excludes summary-card values, user rows, field values, and response bodies, and never changes filters or submits actions. A separate incident-scoped flow may collect a specific user's spending evidence after the target and time window are explicit.
- The operator has designated the `Clear Last Hours` control under Admin Console / Recent Requests as permanently prohibited. Never click or submit it, even when a caller goal requests it; its effect has not been independently verified.
- The operator reports that Recent Requests supports filtered JSONL downloads for different time periods. Inventory filter and time-period choices without exporting. Treat JSONL as request-level sensitive; export only for an explicitly scoped incident and with the required FreeInference authorization.
- The operator reports that Admin Console → Overview → Providers has Overview and Performance subtabs, with dropdowns and a filter text field on Performance. Inventory labels and choices only; do not type or change selections. `Manage`, `Edit`, `Add`, and `Delete Keys` are prohibited controls in the Providers surface.
- Audit Log purpose is unknown and the operator prohibited interaction. Do not open that surface or use its dropdowns; preserve its controls as unknown without probing.
- The Cloud Agent Admin Audit page is separate from the account Admin Console Audit Log. The former has its own operator-directed category recipe; the latter is prohibited and its route is blocked from direct navigation.
- Admin Console Settings and Config may be inventoried read-only after the operator opens the exact surface. Use `discover:staging-admin-config` to record visible control labels, select option labels, and toggle states. Never read input or textarea contents; do not operate controls or change settings without explicit FreeInference authorization. Reports must identify whether evidence came from a live browser, screenshot, or synthetic fixture.
- Synthetic Cloud Agent observations in unit tests validate adapter logic only. Their control labels and shapes are not evidence about the live product and must not be presented as a live UI inventory.
- Admin inventory reports include control names and native select choices, checkbox/switch state, table headers and row counts, and same-origin GET route shapes. They omit free-text field values, table cells, response bodies, and query strings; they do not submit forms, modify settings, or query database tables.
- Staging qualification does not create Agent jobs or mutate admin resources. Such operations require a separately scoped PR test request.

## Verification

```bash
node --test test/testing.test.js test/goal-steps.test.js test/qualifyCloudAgent.test.js test/qualifyTarget.test.js test/staging-admin-discovery.test.js test/e2e-vertical.test.js
```

E2E vertical tests require a real Chrome environment and fixture server.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `execution/` | Workflow scheduling and validated type-to-handler dispatch |
| `lifecycle/` | Durable run bindings, leases, checkpoints, interventions, and continuation |
| `targetLeaseStore.js` | SQLite-backed exact browser-target lease ownership and fencing |
| `steps/` | Isolated workflow control-flow step behavior |
| `telemetry/` | Workflow decision events and durable operation receipt integration |
| `cloudAgentEntry.js` | Cloud Agent identity hints, visible-entry workflow, readiness checks, and read-only link inventory |
| `qualificationRunSelection.js` | Pre-attachment durable run selection, resume binding, and explicit abandonment |
