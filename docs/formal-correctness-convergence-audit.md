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

The repository also has separate run-context, replay, recovery, action-attempt, evidence-store, frame/candidate collection, browser action, capability, MCP tool, run-state, and semantic compiler components. `ActionAttemptCoordinator` now owns the shared write-ahead, reservation, injected-dispatch, and dispatch-record sequence without direct browser or authorization capability. Remaining large coordinators are documented in `architecture-decomposition.md`; their extraction must preserve the single authorized executor, target lease, evidence owner, and durable state transitions.

## Dispatch-outcome convergence

The October 20 execution audit's first three dispatch-boundary findings are addressed in the working tree:

| Finding | Status | Evidence and limit |
| --- | --- | --- |
| EX-01 — Error-message stale retry can repeat an uncertain action | Addressed | `NavigationEngine` no longer uses error text to classify dispatch or retry. Executor outcomes carry `refused_pre_dispatch`, `dispatched_unverified`, `partially_dispatched_uncertain`, or `uncertain`; only the first proves that browser input was not sent. `test/navigation.test.js` asserts one physical click and unresolved reconciliation after unchanged and partially changed state. Explicitly typed refusal still allows fresh observation and normal replanning. |
| EX-02 — Partial composite action loses its uncertain status | Addressed | The executor exposes `partially_dispatched_uncertain` and `dispatchStatus: uncertain`; the engine preserves that disposition through the attempt journal and stops after read-only observation. Executor regressions assert that partial selection cannot advance as a complete operation. |
| EX-03 — Dispatch callback exceptions leave an untyped pending attempt | Addressed for callback exceptions and journal recovery | `ActionAttemptCoordinator` converts untyped callback exceptions to `uncertain`, retains the error, records disposition, and persists the attempt before returning. A failed dispatch-telemetry callback marks `telemetryIncomplete` without changing the effect disposition. On resume, any still-pending action is classified as uncertain before reconciliation. Regression coverage makes the post-dispatch journal write fail and confirms the earlier write-ahead pending record remains; it does not claim that the failed write itself became durable. |
| EX-04 — Combined observation may mix capture epochs | Unqualified | The consistency risk has not been reproduced or ruled out. Keep the current parallel capture path; investigate controlled DOM, OOPIF, and viewport changes before proposing serialization or a capture epoch. |
| EX-05 — Peer request retry may create a second task | Unqualified | Peer request idempotency is not implemented or needed to qualify the local browser fixture. Retried remote peer requests may still require task reconciliation; preserve compatibility while evaluating a caller-owned idempotency key. |
| EX-06 — Reattachment may leave session-bound callbacks on an old session | Unqualified | Exact-target reattachment is tested for ordinary click recovery, but visual and workflow capability callbacks after replacement have not been exercised. They must use fresh session/evidence bindings or abstain. |
| EX-07 — Overlapping observations may publish out of order | Addressed for session publication and effect admission | `BrowserSession.observe()` assigns a monotonic request sequence and publishes `latestEvidenceId` only when the newest request completes on the same attached target and document generation. Older/detached results are tagged historical; the authorized executor refuses them before effects and checks the sequence again at the dispatch boundary. `test/session-lifecycle.test.js` resolves A-starts/B-starts/B-finishes/A-finishes and invalid target/document-generation cases; `test/authorized-executor.test.js` proves historical evidence cannot dispatch. This does not establish atomic consistency among CDP fields within one capture; EX-04 remains separate. |

The typed outcome contract is internal; external API responses and canonical task status values remain unchanged. The backward-compatible task-journal allowlist now accepts bounded dispatch metadata, while older pending records without it still resume as uncertain. The EX-07 change passes **103 focused tests**, plus the disposable headless native-CDP and recursive-OOPIF Chrome integrations. Full LC-02 boundary fault coverage, nested multi-action crash continuation, reattachment closure rebinding, capture coherence, and peer idempotency remain separate work; none is being described as impossible.

## Headless verification and limits

The historical post-extraction full pair used `npm run test:isolated -- --test-concurrency=1` with identical `node --test` discovery and serial execution. Headless explicitly unset `DISPLAY`; headed used private Xvfb, not the physical desktop. Compatible Chrome fixtures used `--headless=new` only in the headless run. Both commands required escalation because the sandbox blocked local sockets/processes.

- Headless: **886 passed, 0 failed, 5 skipped** (891 tests; 309.43 seconds TAP).
- Private-Xvfb headed: **887 passed, 0 failed, 4 skipped** (the same 891 tests; 289.07 seconds TAP).
- Both runs used the same serial test discovery. Headless skips both desktop-placement checks; private Xvfb can check generic bounds on its private screen but skips physical secondary-display reuse. Three skips are shared: opt-in extension integration, missing second-provider configuration, and unavailable authorized staging session.
- Focused API run/shutdown/peer-executor regressions: **20 passed, 0 failed**. Focused API run-route and task-store regressions: **22 passed, 0 failed**.
- API test-run lifecycle extraction regressions: **55 passed, 0 failed**, including authentication order, start/status/cancel/report, resume reconciliation, and shutdown fault injection.
- Focused navigation/planner/telemetry regressions after provider-plan extraction: **102 passed, 0 failed**.
- Opt-in headless extension subset: **1 passed, 0 failed, 0 skipped** on the current tree (**16.25 seconds**). It covers explicit popup consent through a `userGesture` handler call on two exact tabs, Native Messaging grants, native CDP observation, and protected-route cookie preservation.
- Headless OOPIF fixture: direct and nested frame recovery plus root-page scroll passed.

These full-suite results are a historical baseline from before the typed dispatch-boundary changes below, not qualification of the current tree. That run also exposed a timing race in the 600-control retained-lookup fixture; the fixture now waits for the exact OOPIF target and a quiet mutation stream before observing. Production freshness checks were unchanged.

On the current tree, the focused executor, coordinator, navigation, recovery, journal, and workflow command passed **93 tests, 0 failed, 0 skipped**. The headless native CDP and nested-OOPIF integration command passed **2 tests, 0 failed** in **45.2 seconds**; the CDP flow verified its 2-action/1-recovery run, and the OOPIF test verified that a click whose result is lost during target detach remains recorded as uncertain and causes no second dispatch. The earlier private-Xvfb CDP run passed in **57.80 seconds**, verifying the same 2-action/1-recovery flow, private-screen placement, and typed overlay handoff.

The current API-to-CDP fixture waits for the local page to finish loading and asserts its URL/title, then checks visible state, 1280×720 viewport, 1× device scale, and emulated 1280×1024 screen both before and after ActiveTab attaches. Four interleaved pairs through the shared wrapper all passed with one action and the same final `Archive` page; the only Chrome mode argument difference was `--headless=new`.

- Headless test durations: **4.43, 3.44, 9.73, 15.88 seconds**; median **7.08 seconds**.
- Private-Xvfb headed test durations: **5.29, 5.09, 19.98, 11.57 seconds**; median **8.43 seconds**.
- The headless median was **16.0% faster**. It was faster in three pairs and 37% slower in the fourth; the ranges overlap broadly (3.44–15.88 seconds and 5.09–19.98 seconds). This is a close median for this local workload, not a stable latency guarantee. After the final pair the host reported load averages 26.48/39.19/46.61, 3.3 GiB available memory, and 14 GiB swap in use.

The current-tree serial headless suite passed **889 tests, 0 failed, 0 canceled, 5 skipped** (894 total; **263 seconds**). The two headless-only skips are desktop-window coordinate checks; the other three are shared opt-ins/environment gaps: extension integration, an unavailable second-provider endpoint, and no authorized headed staging session. Test code now allows 45 seconds for real Chrome's CDP startup (previously 15), and the broad native-CDP fixture allows 180 seconds overall (previously 90); runtime timeout behavior is unchanged. An earlier run under higher load timed out in that fixture and exposed the OOPIF fixture's former expectation that navigation continue after a lost dispatch result. That fixture now asserts the conservative current contract: fresh evidence and an out-of-band fixture oracle show the click effect, the attempt remains `uncertain`, and no further action is dispatched without reconciliation.

The separate response-inspection benchmark's six-sample results above exercise a different, unchanged code path. The desktop checks remain unequal: private Xvfb verifies generic window bounds on its own screen, while headless skips placement; neither mode verified the physical HDMI-1 monitor during this task.

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

1. Continue `NavigationEngine` decomposition from its remaining run-loop planning and result coordination while retaining one public run loop and the current executor. `ActionAttemptCoordinator` now sequences write-ahead attempt state, reservation, the injected authorized-dispatch callback, and dispatch disposition. Run-local classification lives in `runIntent.js`; task-scope expansion in `planningEvidence.js`; provider planning in `providerPlanCoordinator.js`; workflow planner selection in `workflowRoutePlanner.js`; advisory visual assessment and grounding in `visualDecisionCoordinator.js`; and registered pagination in `registeredPagination.js`.
2. Continue decomposition from the largest remaining coordinators. HTTP modules now cover discovery, capabilities, interventions, approvals, evidence releases, test-run dispatch and lifecycle, legacy run records, catalog reads, run creation/peer execution, bounded output-file serving, and shutdown coordination; general request dispatch and server lifecycle composition remain in `local-server.js`.
3. Measure response acquisition/process memory as best-effort diagnostics; keep `hardMemoryBound:false` until the transport can enforce a pre-materialization limit.
4. Extend the multi-process fault matrix to CDP response loss, postcondition verification, receipt persistence, interrupted atomic replacement, live-owner heartbeat failure, and operator revocation; the current tests qualify durable-store transitions, lease renewal, and fencing.
5. Run held-out application and live staging qualifications when their authorized environments are available.
