# Runtime Decomposition Workstream

ActiveTab is being decomposed through behavior-preserving extractions. One application workflow coordinator and one authoritative effect executor remain in control. Component boundaries may move scheduling, transport, verification, storage, and integration work; they do not create alternate browser or application execution authorities.

## Current pressure points

| Area | Current entrypoint | Current responsibility pressure |
| --- | --- | --- |
| Declarative workflows | `src/testing/runner.js` (654 lines after lifecycle, telemetry, handler, dispatcher, and intervention extractions) | Workflow scheduling and collaborator coordination |
| Navigation | `src/navigation/engine.js` (2,241 lines) | Planning, browser coordination, recovery, replay, and execution coordination |
| MCP transport | `src/mcp/server.js` (270 lines) | Protocol startup and injected handler composition |
| HTTP transport | `src/api/local-server.js` (957 lines after discovery, capability, intervention, approval, evidence-release, and test-run route extractions) | Lifecycle implementations and general composition remain server-owned |
| Staging qualification | `scripts/qualify-staging.mjs` (416 lines) | Browser entry, handoff, qualification, diagnostics, reporting, and persistence |
| FI Agent Twin | `test-lab/fixtures/fi-agent-twin/provider.js` (247 lines after frontend, HTTP, auth, persistence, and job-service extractions) | Provider lifecycle still includes application routing and independent-oracle HTTP projection |
| Response diagnostics | `src/observe/responseBodyInspector.js` (332 lines, with focused parser, format, security, shared, and Markdown modules) | Selected-body acquisition coordination, interpretation, and safe operator views |

These are extraction targets. Size alone is not evidence of a defect.

## Stage 1 — Workflow scheduling boundary

`src/testing/execution/workflowScheduler.js` owns pure scheduling decisions:

- DAG dependency, status-condition, compensation, and sequential recovery-branch admission.
- Terminal workflow status derivation.
- Trusted subworkflow reference validation and expanded step-cost calculation.

`TestRunner` still owns run identity, durable checkpoints, cancellation, receipt updates, handler coordination, and continuation. It applies scheduler decisions and checkpoints them. `StepDispatcher` performs validated type-to-handler routing. Neither component authorizes or directly dispatches effects. This extraction is in place and is covered by scheduler tests plus the existing workflow tests.

## Stage 2 — TestRunner orchestration

Nine collaborator extractions are in place. `src/testing/telemetry/runDecisionRecorder.js` owns the workflow runner's episode lifecycle, policy/review event hooks, durable operation reservations, dispatch receipts, and verification linkage. `src/testing/lifecycle/runStateCoordinator.js` owns durable run bindings, leases, checkpoints, and durable run status. `src/testing/lifecycle/interventionCoordinator.js` owns persisted human handoffs, resume fencing, fresh completion predicates, and continuation via the existing runner callback. `src/testing/execution/stepDispatcher.js` routes validated step types to their handlers while preserving error receipt behavior; it has no policy or effect authority. `src/testing/steps/controlFlowStepHandler.js` owns scalar variable assignment, bounded repetition, and trusted subworkflow composition, re-entering the same runner through an injected callback. `src/testing/steps/verificationStepHandler.js` owns bounded observation checks, diagnostic snapshots, and cleanup verification; cleanup dispatch re-enters the runner's authorized API or interaction path. `src/testing/steps/qualificationStepHandler.js` records the configured Fixture Lab result as advisory or required according to the workflow. `src/testing/steps/browserStepHandler.js` owns navigation and interaction step behavior; all browser effects still pass through the shared authorized executor. `src/testing/steps/apiStepHandler.js` dispatches registered typed diagnostic operations and preserves refusal, failure, and uncertainty without treating collection as outcome verification. `TestRunner` retains workflow ownership, receipt progression, scheduling, cancellation, and collaborator coordination; the collaborators do not grant authority or create alternate transport paths.

Target boundaries:

| Component | Owns |
| --- | --- |
| `TestRunner` facade | Run entry, dependency composition, final receipt handoff |
| `WorkflowScheduler` | Ordering, conditional eligibility, bounded graph validation |
| `StepDispatcher` | Validated type-to-handler routing; no policy decisions |
| `ExecutionContext` | Scoped variables, workflow stack, budgets, step statuses |
| Run lifecycle services | Durable state, lease fencing, suspension, resume, cancellation |
| Verification services | Assertions, independent postconditions, cleanup checks |
| Step handlers | Step-specific evidence gathering and requests to the shared authorized executor |

Extract handlers by responsibility while preserving the receipt shape, state transitions, run identity, cancellation points, and dispatch ordering. No handler receives direct unrestricted CDP methods.

## Stage 3 — Navigation coordination

Keep `TestRunner` as the top-level declarative workflow owner. `NavigationEngine` remains a subordinate navigation capability. `src/navigation/outcomeVerifier.js` owns pure visible-destination checks and privacy-preserving initial page-label hashes; it does not verify application-side effects. `src/navigation/applicationRunService.js` is the shared MCP/HTTP run lifecycle boundary. `runContext.js` owns per-run counters, bindings, observations, and failure-derived exclusions. `ReplayCoordinator` validates stored workflow signatures and preconditions; `RecoveryCoordinator` performs bounded fresh observation and exact-target reattachment without replaying actions; `ActionAttemptCoordinator` persists attempt metadata without dispatch. `planningCycle.js` owns candidate/scroll exclusion projection and bounded planner-option construction. `planningEvidence.js` owns the one bounded expansion of incomplete task-scoped interaction evidence and accepts only fresh evidence for the attached target. These modules do not authorize or dispatch effects.

`NavigationEngine` still owns task-intent routing, planner selection, provider and visual-review coordination, target freshness, policy admission, and the call into the authorized executor. At 2,231 lines it remains an active decomposition target. The next planner extraction must preserve its inference budget, visual-evidence binding, candidate identity, telemetry lineage, and abort behavior. Keep target admission and the final dispatch call in the existing authorized execution path; do not create a second planner-side action path.

## Stage 4 — Shared application services for transports

The shared run service is in place for MCP and HTTP. `src/mcp/server.js` is a 270-line protocol startup/composition module. `src/api/local-server.js` is now 957 lines after extracting discovery, capability, intervention, public-read approval, evidence-release, and test-run dispatch into injected route modules. Test-run lifecycle implementations and general request dispatch remain composed there. Continue extracting endpoint families with injected server-owned dependencies while MCP and HTTP retain request validation, authentication, protocol serialization, and response mapping. Do not move leases, principals, grants, stores, or execution authority into request-controlled route data. Both transports must preserve identical policy and lifecycle semantics.

## Stage 5 — Qualification and fixture composition

`src/testing/cloudAgentEntry.js` owns Cloud Agent identity hints, visible-entry workflow construction, task-composer readiness checks, and read-only diagnostic-link inventory. `src/testing/qualificationRunSelection.js` owns durable staging-run selection and exact resume/abandon checks before browser attachment. The long-running qualification coordinator retains intervention, diagnostic, and report orchestration. Continue extracting staging browser lifecycle and reporting from `scripts/qualify-staging.mjs`. FI Agent Twin HTML rendering, bounded HTTP helpers, realm-scoped auth/MFA, private SQLite persistence, and Agent job behavior now live in focused modules under `test-lab/fixtures/fi-agent-twin/`. The provider retains server lifecycle, route composition, and the independent-oracle projection. The driver receives no oracle credentials or hidden scenario state.

## Stage 6 — Response diagnostics and Markdown views

Selected response inspection now separates JSON-like repair, non-JSON format analysis, credential discovery/redaction, shared primitives, and Markdown projection. Markdown is a navigable report view: headings, nested tables, indexed diagnostics, fenced source blocks, and byte paging point back to complete safe source. Trusted local callers can select an indexed section subtree or data block, then page within it while retaining document-relative byte offsets. Sparse UTF-8 indexing and sequential cursors avoid rescanning the full prefix; repeated pages reuse a short-lived, size-bounded redacted projection. Complex diagnostics remain drillable without replacing typed parse evidence, repair details, or source provenance. Markdown is not the parser's source of truth, and its interpretation cannot authorize actions or verify outcomes. CDP still supplies a selected response body as a whole protocol result, so report paging does not bound acquisition memory.

## Stage 7 — Workflow synthesis boundaries

`src/navigation/workflowCapabilityCatalog.js` owns deterministic validation of trusted workflow capability declarations and construction of the model-safe catalog projection. Trusted resolver, verifier, and extraction functions remain in its local normalized catalog; only bounded codes, roles, effects, and dynamic-resolution metadata enter the provider projection. `src/navigation/workflowObservationProjection.js` compiles bounded candidates, scroll targets, and semantic-page context from one supplied observation while retaining exact identities in a local binding map and applying the existing label opt-in. `workflowPlanValidator.js` remains the provider-independent graph validator. `WorkflowSynthesizer` composes these boundaries with intent and provider handling without adding a browser dispatch path. Task-intent inference remains a separate extraction candidate.

## Qualification evidence and remaining benchmark gap

The native CDP API path now discovers a request already issued by a fixture page, inspects only its explicitly selected retained response, and scores its schema against 30 provider-side seeded variants. Extraction qualification has 30 deterministic structural variants plus one independently maintained WebArena-Infinity extraction scenario. The controlled navigation suite covers 10 page variants with independent browser-state checks. These are useful qualification slices; they do not yet constitute held-out visual-accuracy and cross-application API/extraction/failure benchmark coverage. Screenshot forwarding is tested as a privacy and request-shape contract, not as a measured visual-accuracy benchmark.

## Acceptance gates

- Compare receipts, durable state, cancellation, resume, and reconciliation before and after each extraction.
- Exercise browser and API effects through the same authorized executor.
- Compare MCP and HTTP behavior for the same run contract.
- Keep model calls within the same durable per-run inference budget.
- Preserve native CDP control and independent fixture oracles.
- Run the focused suites and the repository's full test command in a disposable environment.
- Make each stage independently reviewable and commit it separately.

Each extraction must preserve the existing behavioral contract. Record unresolved gaps as such; unit tests do not establish live staging qualification.
