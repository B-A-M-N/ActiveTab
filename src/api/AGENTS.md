# ActiveTab HTTP API

## Purpose

Owns local HTTP composition and endpoint-family adapters.

## Ownership

`local-server.js` owns server construction, host/origin checks, request diagnostics, shared dependencies, and route ordering. Route modules handle one endpoint family using dependencies injected by that composition layer.

## Local Contracts

- Route handlers do not create alternate browser execution or policy paths. Browser effects use the existing application run service or authorized executor.
- Authentication and operator identity come from server-owned authenticators. Request bodies contain caller input only and cannot select trusted identity, knowledge storage, or grant configuration.
- Durable run-state and target lease operations use the configured stores and existing coordinators.
- Legacy run creation fails closed when the server-owned executor is unavailable. The peer endpoint keeps its separate peer-token authentication; it does not rely on the local API token.
- Compatibility and peer run JSON roots must be non-null objects. Missing or invalid required fields return 400 without creating a task. Preparation that can run without a task ID happens before task creation; later preparation or scheduling failure is persisted as a bounded failed record before the handler responds.
- One API process owns a canonical task directory. `TaskStore.init()` acquires a process-held SQLite write transaction before task recovery or HTTP listen; a second API process sharing the directory fails startup. SQLite releases ownership on orderly close or process death, and the API task directory/lock database remain owner-private.
- Task capacity is enforced in `TaskStore.create` as the synchronous admission point. The single-writer lock makes that in-memory count authoritative across API process restarts and prevents cross-process over-admission or stale task updates.
- The peer endpoint requires a bounded `Idempotency-Key` header after peer-token authentication. The key is scoped to the configured shared peer-token principal and a canonical fingerprint of execution fields; only digests and task identity are persisted before `RunLifecycle.start()`. An equivalent retry joins the live worker or returns its existing durable result. A conflicting fingerprint returns 409, and an interrupted/indeterminate task is returned unresolved without replay.
- Terminal task status, output, error, and metadata are immutable. Legacy cancellation persists `cancel_requested` before aborting an active worker; only an explicit pre-dispatch result may settle as `canceled`. Cancellation after possible dispatch settles as `reconciling`, and restart converts an unsettled cancellation request to `reconciling` rather than claiming the effect did not occur.
- Shutdown closes HTTP admission, persists cancellation intent before aborting active test-run controllers, and waits on one settlement promise that is replaced when a run resumes. If a worker does not settle within the configured bound, it remains nonterminal for reconciliation and resource closure is deferred until its settlement; shutdown never manufactures a terminal receipt.
- Route extraction preserves method/path matching, status codes, response bodies, authentication order, redaction, and error behavior. Output-file serving remains behind API authentication and retains its path, extension, and size checks.
- The discovery routes use server-composed environment, principal, and canonical knowledge directory. Discovery holds the current target lease for its run.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `routes/` | Endpoint-family handlers with injected server-owned dependencies |
| `routes/capabilities.js` | Capability discovery, read, compile, qualification, listing, and revocation endpoints after shared API authentication |
| `routes/interventions.js` | Intervention status, acknowledgement, approval, resume, cancellation, and run-state endpoints with server-owned authentication and tools |
| `routes/publicReadApprovals.js` | Public-read requests and status under API authentication; listing and resolution require the independent operator authenticator |
| `routes/evidenceReleases.js` | Independent-operator-only evidence release review, audit, and grant revocation backed by the server-owned release store |
| `routes/testRuns.js` | API-authenticated test-run route dispatch into server-owned lifecycle and reporting handlers |
| `testRunLifecycle.js` | Test-run worker ownership, resume/cancel coordination, durable status projection, and reports; no HTTP auth or route matching |
| `routes/legacyRuns.js` | Compatibility API run listing, status, detail, and cancellation after shared API authentication; task store and lifecycle stay server-owned |
| `routes/catalog.js` | Authenticated bot, template, and region catalog reads with compatibility response shapes |
| `routes/runExecution.js` | Compatibility run creation and peer execution using server-owned lifecycle, stores, executor, and extraction release policy |
| `outputFileHandler.js` | API-authenticated bounded reads of task output files with allowlisted extensions and MIME types |
| `shutdownCoordinator.js` | Bounded API shutdown, persisted cancellation-before-abort, settlement waiting, and deferred owned-resource closure |
