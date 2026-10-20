# Formal Correctness Convergence Audit — Execution Record

As of 2026-10-20, branch `feat/audit-hardening`. This record tracks implementation and qualification work against the attached audit; it supersedes that audit's older line counts and test baseline where current evidence exists.

Status terms: **addressed** means the identified source defect has a code and regression-test remedy; **locally qualified** means the behavior passed controlled local browser fixtures; **partial** means bounded mitigation exists but its full guarantee is not demonstrated; **unqualified** means evidence is still required.

## Confirmed findings

| Finding | Status | Current evidence and remaining limit |
| --- | --- | --- |
| AT-C01 — Request-controlled discovery filesystem path | Addressed | HTTP discovery ignores absolute, relative, and traversal `knowledgeDir` inputs. `KnowledgeStore` requires an owner-private canonical root, rejects symlink escapes, writes atomically, and retains or clears only validated store entries. Covered by `api-discovery-filesystem.test.js` and `knowledgeStore.test.js`. |
| AT-C02 — Discovery knowledge scope | Addressed | Reuse keys bind origin, environment, application, authentication realm, and verified principal. Discovery loads and saves with the same trusted scope; legacy unscoped entries are not reusable. Covered by discovery and knowledge-store tests. |
| AT-C03 — Targeted CDP query deadlines | Addressed with explicit timeout semantics | Per-command timeout removes the pending reply association; late replies cannot reach the expired consumer. Visual probes are single-flight per target and newer observations invalidate the result consumer. Timeout does not claim Chromium canceled an already-sent query. Covered by `cdp-client.test.js` and `session-lifecycle.test.js`. |
| AT-C04 — Response-body acquisition memory | Partial mitigation; hard bound remains unavailable | Explicit sensitive-body opt-in, streaming-type refusal, known-size preflight, one pending acquisition per browser session, post-acquisition byte checks, and `hardMemoryBound:false` are implemented. Unknown size is reported as `size_unknown`. CDP still materializes a complete response body before ActiveTab can inspect its size; acquisition-time peak RSS/heap is not measured, and no hard memory bound is claimed. Covered by `observer-activity.test.js`, `response-body-inspector.test.js`, and documented in `src/observe/AGENTS.md`. |

## Operational qualification

| Area | Status | Evidence and remaining limit |
| --- | --- | --- |
| OOPIF visual hit recovery | Locally qualified | Headless Chrome resolved exact candidates through direct and nested attached OOPIF sessions with the parent page scrolled. The probe remains read-only and advisory. `oopif.integration.test.js` verifies frame depth, exact candidate identity, and no action authority. Held-out frame-heavy applications remain unqualified. |
| Virtualized-list navigation and replay | Locally qualified, restart continuation partial | Native CDP fixtures reveal a virtualized record with bounded wheel input. Workflow replay checks a fresh scroll target, visible-candidate fingerprint, and saved position. Collection restart uses safe cursor bindings or restarts from the beginning; held-out application continuity and exact-count behavior remain unqualified. |
| Same-URL button pagination | Locally implemented and fixture-tested | Registered pagination re-resolves an exact visible button, dispatches through the shared authorized executor, checks same-origin/path scope, and requires a changed page fingerprint. No held-out application qualification is recorded. |
| Live staging forms and diagnostics | Unqualified | The ordinary headless suite did not acquire an authorized staging session. The repository contract requires headed Chrome for live/staging qualification. The current environment has no second virtual screen; no staging result is inferred from fixture tests. |
| MCP sensitive-evidence release | Local adversarial coverage present; operator-flow E2E unqualified | Local grant, principal, scope, and release tests pass. No connected independent operator session was used for an end-to-end release. |
| Long-running lifecycle and recovery | Partial | Local browser and server restart, uncertain-action, reattachment, and fencing tests pass. The full multi-process failure-injection matrix across authorization, reservation, dispatch, observation, verification, and receipt persistence remains unqualified. |
| Held-out public-site generality | Unqualified | Existing real-site observation evidence and local benchmark fixtures do not establish cross-application/version correctness. No live staging or public-site qualification is claimed here. |

## Decomposition delivered

Recent behavior-preserving slices are separate commits:

- `e56e9a6` — extract navigation planning-cycle projection.
- `086e05d` — extract capability API route handlers behind existing request gates.
- `1aa33d3` — resolve visual hits through exact OOPIF sessions.
- `91ae4b3` — extract trusted workflow capability catalog compilation.
- `cbb476d` — extract bounded workflow observation projection and local identity bindings.
- `a770cf1` — extract bounded task-scope observation expansion with same-target freshness acceptance.
- `847501d` — extract intervention HTTP routes behind injected server-owned dependencies.
- `0f642f4` — extract public-read approval routes with API and independent-operator authentication preserved.
- `dd3a202` — extract evidence-release review, audit, and revocation routes; add adversarial route-boundary tests.
- `4eb1117` — extract API-authenticated test-run route dispatch while retaining lifecycle handlers in the server composition.
- `1b81b6a` — extract workflow route selection and planner construction after trusted task resolution, with explicit abstention preserved.
- `b2a37ea` — extract permission-gated visual assessment and candidate grounding while retaining fresh evidence checks and engine-owned policy admission.
- `bfd839e` — extract compatibility API run listing, status, detail, and cancellation into an injected route module; preserve outer API authentication and server-owned task store/lifecycle dependencies.
- `540514b` — extract registered pagination target resolution, authorized dispatch, and progress verification; retain the engine compatibility export and exact lease checks.
- `b85aa06` — extract authenticated compatibility bot, template, and region catalog reads while retaining capability-route priority and the existing `/v3` authentication gate.
- `86e3a6d` — extract compatibility run creation and peer execution handlers with the outer API gate, peer-token check, server-owned executor, and extraction release policy preserved.
- `935ba8a` — extract bounded output-file serving; retain the API authentication gate and verify path, extension, size, MIME, and response behavior.
- `b3f8f7f` — route `/v1/interventions/run-state` before the generic intervention-ID matcher so the run-state handler is reachable.
- `b3c66a8` — give the 600-control retained-lookup fixture the existing maximum query timeout; production defaults are unchanged.

The repository also already has separate run-context, replay, recovery, action-attempt, evidence-store, frame/candidate collection, browser action, capability, MCP tool, run-state, and semantic compiler components. Remaining large coordinators are documented in `architecture-decomposition.md`; their extraction must preserve the single authorized executor, target lease, evidence owner, and durable state transitions.

## Headless verification and limits

The latest complete run used `ACTIVETAB_HEADLESS=1 npm test -- --test-concurrency=1` through an owner-private disposable state directory. It used the standard `node --test` discovery and serial file execution, with compatible Chrome fixtures launched as `--headless=new`.

- Full suite after bounded output-file handler extraction: **864 passed, 0 failed, 5 skipped** (869 tests; 105.70 seconds).
- Focused output/API regression: **43 passed, 0 failed**; API-server rerun after the authentication assertion: **35 passed, 0 failed**.
- Opt-in headless extension subset: **1 passed, 0 failed, 0 skipped**. It covers explicit popup consent through a `userGesture` handler call, exact-tab grants, Native Messaging, CDP observation, and protected-route cookie preservation.
- Headless OOPIF fixture: direct and nested frame recovery plus root-page scroll passed.

Headless does not verify desktop window coordinates or physical toolbar interaction. The extension subset's `Runtime.evaluate(userGesture:true)` path is not evidence of a physical popup click; the full extension UI, DevTools keyboard interaction, and desktop placement remain headed-only checks. The five standard-suite skips include those display checks, the opt-in extension scenario, an unavailable second-provider configuration, and the staging session check. The display, staging, provider, and extension limits are also described in `testing-display.md`.

No headed equivalence is claimed for skipped desktop behavior. Live/staging qualification remains pending an authorized headed display and staging session; fixture and headless success do not substitute for it.

## Next bounded slices

1. Continue `NavigationEngine` extraction from provider planning and attempt coordination while retaining one public run loop and the current executor. Task-scope expansion lives in `planningEvidence.js`; workflow planner selection lives in `workflowRoutePlanner.js`; visual assessment and grounding live in `visualDecisionCoordinator.js` and remain advisory; registered pagination is isolated in `registeredPagination.js`.
2. Continue decomposition from the largest remaining coordinators. HTTP route modules now cover discovery, capabilities, interventions, approvals, evidence releases, test runs, legacy run records, catalog reads, run creation/peer execution, and bounded output-file serving; test-run lifecycle implementations and general request dispatch remain composed in `local-server.js` (712 lines).
3. Measure response acquisition/process memory as best-effort diagnostics; keep `hardMemoryBound:false` until the transport can enforce a pre-materialization limit.
4. Run the remaining held-out application and multi-process lifecycle qualifications when their required authorized environments are available.
