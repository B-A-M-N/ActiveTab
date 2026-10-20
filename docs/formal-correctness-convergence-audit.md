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
| AT-C05 — Malformed run request roots | Addressed | Ordinary and peer run routes reject `null`, arrays, strings, numbers, booleans, and missing required fields with 400 before task creation. Tests exercise both handler paths, including malformed input while task capacity is full. |
| AT-C06 — Peer task capacity bypass | Addressed within one API process | Ordinary and peer routes use the same `TaskStore.create` capacity admission; a concurrent-create regression proves one slot cannot be over-admitted in one process. Each process has its own in-memory task map, so this is not a cross-process quota when multiple API processes share one task directory. |
| AT-C07 — Persisted queued task after preparation or scheduling failure | Addressed with a persistence-failure limit | Goal rendering runs before task creation. Task-ID-dependent extraction preparation and scheduler failures transition the persisted task to `failed` with a static bounded diagnostic. If that failure transition itself cannot be persisted, the handler returns 503 and the original queued record remains subject to startup reconciliation. |
| AT-C08 — Shutdown races test-run settlement | Addressed with bounded reconciliation | Shutdown stops admission, persists cancellation intent before abort, and tracks a settlement promise that advances across resume. Fault-injection tests verify cancellation persistence failure does not abort, timeout leaves the run nonterminal, and owned resources close only after settlement. A worker that never settles keeps owned resources open until settlement; process termination leaves its durable record available for normal run-state recovery and reconciliation. |

## Operational qualification

| Area | Status | Evidence and remaining limit |
| --- | --- | --- |
| OOPIF visual hit recovery | Locally qualified | Headless Chrome resolved exact candidates through direct and nested attached OOPIF sessions with the parent page scrolled. The probe remains read-only and advisory. `oopif.integration.test.js` verifies frame depth, exact candidate identity, and no action authority. Held-out frame-heavy applications remain unqualified. |
| Virtualized-list navigation and replay | Locally qualified, restart continuation partial | Native CDP fixtures reveal a virtualized record with bounded wheel input. Workflow replay checks a fresh scroll target, visible-candidate fingerprint, and saved position. Collection restart uses safe cursor bindings or restarts from the beginning; held-out application continuity and exact-count behavior remain unqualified. |
| Same-URL button pagination | Locally implemented and fixture-tested | Registered pagination re-resolves an exact visible button, dispatches through the shared authorized executor, checks same-origin/path scope, and requires a changed page fingerprint. No held-out application qualification is recorded. |
| Live staging forms and diagnostics | Unqualified | The ordinary headless suite did not acquire an authorized staging session. The repository contract requires headed Chrome for live/staging qualification. The current environment has no second virtual screen; no staging result is inferred from fixture tests. |
| MCP sensitive-evidence release | Local adversarial coverage present; operator-flow E2E unqualified | Local grant, principal, scope, and release tests pass. No connected independent operator session was used for an end-to-end release. |
| Long-running lifecycle and recovery | Partial | `test/run-lifecycle-multiprocess.test.js` uses real parent/child Node processes and disposable production-format state to verify lease exclusion and heartbeat renewal, `SIGKILL` recovery with fencing advancement, crashes after reservation and dispatch without replay, concurrent equivalent-effect reservation exclusion, cleanup-required persistence after crash, cross-process revision compare-and-swap, and owner-private modes. Existing executor tests separately verify refusal after lease loss and uncertainty after a CDP dispatch error. Process crashes during CDP response loss, postcondition verification, receipt persistence, interrupted JSON replacement, failed heartbeat while an owner remains alive, and operator revocation remain unqualified. |
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
- `b885ead` — extract run-local search/read classification and workflow-mode selection while leaving trusted capability resolution and action dispatch in their existing owners.
- `77bc3d1` — validate compatibility/peer JSON roots before task admission, enforce capacity in `TaskStore.create`, persist preparation/scheduler failures, and extract bounded shutdown settlement coordination after fault-injection coverage.
- `19e6b0b` — extract provider-plan routing from `NavigationEngine` while retaining planner-failure lineage and engine-owned action admission.
- `6db07c5` — move API test-run worker tracking, resume/cancel coordination, durable status projection, and reporting into `testRunLifecycle.js`; retain outer route authentication and matching.
- `3dfb7de` — align headless test display defaults and add a same-surface response-performance comparison.
- `b3f8f7f` — route `/v1/interventions/run-state` before the generic intervention-ID matcher so the run-state handler is reachable.
- `b3c66a8` — give the 600-control retained-lookup fixture the existing maximum query timeout; production defaults are unchanged.

The repository also already has separate run-context, replay, recovery, action-attempt, evidence-store, frame/candidate collection, browser action, capability, MCP tool, run-state, and semantic compiler components. Remaining large coordinators are documented in `architecture-decomposition.md`; their extraction must preserve the single authorized executor, target lease, evidence owner, and durable state transitions.

## Headless verification and limits

The latest full runs used `npm run test:isolated -- --test-concurrency=1` with identical `node --test` discovery and serial execution. Headless explicitly unset `DISPLAY`; headed used the repository's private Xvfb display, not the physical desktop. Compatible Chrome fixtures used `--headless=new` only in the headless run. Both commands required escalation because the sandbox blocked local sockets/processes used by the test fixtures.

- Headless: **882 passed, 0 failed, 5 skipped** (887 tests; 235.36 seconds TAP).
- Private-Xvfb headed: **883 passed, 0 failed, 4 skipped** (the same 887 tests; 249.50 seconds TAP).
- All **875 named test cases** matched in the same order. Headless skipped both desktop-placement checks; private Xvfb skipped physical secondary-display reuse because it exposes one screen. Three skips were shared: opt-in extension integration, missing second-provider configuration, and unavailable authorized staging session.
- Focused API run/shutdown/peer-executor regressions: **20 passed, 0 failed**. Focused API run-route and task-store regressions: **22 passed, 0 failed**.
- API test-run lifecycle extraction regressions: **55 passed, 0 failed**, including authentication order, start/status/cancel/report, resume reconciliation, and shutdown fault injection.
- Focused navigation/planner/telemetry regressions after provider-plan extraction: **102 passed, 0 failed**.
- Opt-in headless extension subset: **1 passed, 0 failed, 0 skipped**. It covers explicit popup consent through a `userGesture` handler call on two exact tabs, Native Messaging grants, native CDP observation, and protected-route cookie preservation.
- Headless OOPIF fixture: direct and nested frame recovery plus root-page scroll passed.

The full headless run also exposed a timing race in the 600-control retained-lookup fixture: its first observation could precede the cross-origin frame's final DOM mutation event, so the correct freshness guard returned `stale`. The fixture now waits for the exact OOPIF target and a quiet mutation stream before observing. Focused headless and private-Xvfb runs and the final full suites pass; production freshness checks were unchanged.

In this full-suite pair, headless completed **14.14 seconds (5.7%) faster** by TAP duration. Earlier pairs were also faster headless, by 8.7% and 9.1%. Host timing varied substantially in absolute terms, so these pairs show no suite-level headless penalty on this host; they do not establish fixed per-test latency parity. The two skipped headless desktop checks were not counted as equivalent passes: the headed Xvfb run covers generic bounds on its private screen and skips physical secondary-display reuse. The Xvfb placement pass verifies bounds inside that virtual display only; it does not verify the physical HDMI-1 monitor origin.

The response benchmark ran six times per mode on Chrome 150.0.7871.114: three samples in mode blocks and three interleaved. Every sample reported the same visible 1280×720 viewport, 1× device scale, and 1280×1024 screen dimensions. All seven response statuses and reason codes matched. Median startup was 1.39 seconds headless versus 2.12 seconds headed; median Chrome process-tree peak RSS was 1,017 MiB versus 1,353 MiB, while Node peak RSS was 138 MiB in both modes. Median end-to-end latency was 6–32% lower headless on six cases and 18% higher on `json-256k`; inspection-only latency was 10% higher on `json-256k` and 20% higher on `text-many-lines`. The sample ranges were wide, including 621–1,426 ms headed and 515–1,262 ms headless for the many-token case. These measurements show matched classifications and surface geometry, with no broad headless runtime penalty in this fixture; they do not show exact per-case latency parity or establish an SLA.

The extension subset's `Runtime.evaluate(userGesture:true)` path is not evidence of a physical toolbar click. Full extension UI behavior, physical toolbar interaction, DevTools keyboard interaction, and physical desktop placement remain unverified. Live/staging qualification remains pending an authorized headed display and staging session; fixture and headless success do not substitute for it. The display, staging, provider, and extension limits are also described in `testing-display.md`.

## Cross-process lifecycle qualification

The focused run `node --test test/runState.test.js test/run-lifecycle-multiprocess.test.js test/authorized-executor.test.js` passed **40 tests**. The new harness starts a separate Node process for each competing owner and uses the production `RunStateStore`, SQLite target lease database, run-document locks, and atomic JSON replacement inside disposable temporary directories. It verifies:

- A process holding one target lease blocks another process while an unrelated target remains available.
- The separate-process lease heartbeat advances while the owner remains alive; killing it with `SIGKILL` permits immediate recovery and advances the fencing token.
- Crashes after durable reservation and after `DISPATCHED` both reconcile to `UNCERTAIN`; repeated reconciliation remains uncertain and equivalent operation reservations are refused.
- Concurrent equivalent effect reservations across processes admit only one reservation.
- A crash after resource registration leaves cleanup `required` after restart.
- Competing run-document updates using the same expected revision yield one commit and one revision conflict; directory, JSON, and SQLite file modes remain owner-private.

This establishes these durable-store behaviors on the local filesystem and SQLite used by this checkout. It does not simulate a CDP request in flight, loss of a browser response, a crash between postcondition verification and receipt persistence, interrupted JSON rename, lease-heartbeat failure while an owner remains alive, or an operator revoking approval during acquisition. Those cut points need additional failpoints or a browser/application-level harness before they can be claimed as process-qualified.

## Next bounded slices

1. Continue `NavigationEngine` extraction from attempt coordination while retaining one public run loop and the current executor. Run-local classification now lives in `runIntent.js`; task-scope expansion lives in `planningEvidence.js`; provider planning lives in `providerPlanCoordinator.js`; workflow planner selection lives in `workflowRoutePlanner.js`; visual assessment and grounding live in `visualDecisionCoordinator.js` and remain advisory; registered pagination is isolated in `registeredPagination.js`.
2. Continue decomposition from the largest remaining coordinators. HTTP modules now cover discovery, capabilities, interventions, approvals, evidence releases, test-run dispatch and lifecycle, legacy run records, catalog reads, run creation/peer execution, bounded output-file serving, and shutdown coordination; general request dispatch and server lifecycle composition remain in `local-server.js`.
3. Measure response acquisition/process memory as best-effort diagnostics; keep `hardMemoryBound:false` until the transport can enforce a pre-materialization limit.
4. Extend the multi-process fault matrix to CDP response loss, postcondition verification, receipt persistence, interrupted atomic replacement, live-owner heartbeat failure, and operator revocation; the current tests qualify durable-store transitions, lease renewal, and fencing.
5. Run held-out application and live staging qualifications when their authorized environments are available.
