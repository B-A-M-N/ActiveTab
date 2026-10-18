# Runtime Decomposition Workstream

ActiveTab is being decomposed through behavior-preserving extractions. One application workflow coordinator and one authoritative effect executor remain in control. Component boundaries may move scheduling, transport, verification, storage, and integration work; they do not create alternate browser or application execution authorities.

## Current pressure points

| Area | Current entrypoint | Current responsibility pressure |
| --- | --- | --- |
| Declarative workflows | `src/testing/runner.js` (882 lines after lifecycle, telemetry, and step-handler extractions) | Workflow scheduling, continuation, and integration calls |
| Navigation | `src/navigation/engine.js` (1,219 lines) | Planning, browser coordination, recovery, replay, and outcome checks |
| MCP transport | `src/mcp/server.js` (766 lines) | Protocol handling mixed with application orchestration |
| HTTP transport | `src/api/local-server.js` (825 lines) | Routes mixed with run lifecycle and process-local service state |
| Staging qualification | `src/testing/qualifyCloudAgent.js` (763 lines) | Browser entry, handoff, qualification, diagnostics, reporting, and persistence |
| FI Agent Twin | `test-lab/fixtures/fi-agent-twin/provider.js` (550 lines) | Provider lifecycle mixed with app, backend, auth, job, and oracle behavior |

These are extraction targets. Size alone is not evidence of a defect.

## Stage 1 — Workflow scheduling boundary

`src/testing/execution/workflowScheduler.js` owns pure scheduling decisions:

- DAG dependency, status-condition, compensation, and sequential recovery-branch admission.
- Terminal workflow status derivation.
- Trusted subworkflow reference validation and expanded step-cost calculation.

`TestRunner` still owns run identity, durable checkpoints, cancellation, receipt updates, step execution, and continuation. It applies scheduler decisions and checkpoints them. The scheduler cannot dispatch operations or authorize effects. This extraction is in place and is covered by scheduler tests plus the existing workflow tests.

## Stage 2 — TestRunner orchestration

Six collaborator extractions are in place. `src/testing/telemetry/runDecisionRecorder.js` owns the workflow runner's episode lifecycle, policy/review event hooks, durable operation reservations, dispatch receipts, and verification linkage. `src/testing/lifecycle/runStateCoordinator.js` owns durable run bindings, leases, checkpoints, and durable run status. `src/testing/steps/controlFlowStepHandler.js` owns scalar variable assignment, bounded repetition, and trusted subworkflow composition, re-entering the same runner through an injected callback. `src/testing/steps/verificationStepHandler.js` owns bounded observation checks, diagnostic snapshots, and cleanup verification; cleanup dispatch re-enters the runner's authorized API or interaction path. `src/testing/steps/qualificationStepHandler.js` records the configured Fixture Lab result as advisory or required according to the workflow. `src/testing/steps/browserStepHandler.js` owns navigation and interaction step behavior; all browser effects still pass through the shared authorized executor. `TestRunner` retains workflow ownership, receipt progression, scheduling, cancellation, and step dispatch; the collaborators do not grant authority or create alternate transport paths.

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

Keep `TestRunner` as the top-level declarative workflow owner. `NavigationEngine` remains a subordinate navigation capability. Extract planning, fresh target binding, replay, recovery, scroll convergence, and outcome verification behind internal interfaces. The existing authorized executor remains the only browser effect boundary. Preserve workflow synthesis and the same per-run inference budget.

## Stage 4 — Shared application services for transports

Introduce one application-owned run service for MCP and HTTP. It owns run creation, continuation, cancellation, process registries, receipt publication, and reconciliation. MCP and HTTP retain transport validation, authentication, protocol serialization, and response mapping. Cloud Agent outcome recording moves to the shared integration/verification service. Both transports must preserve identical policy and lifecycle semantics.

## Stage 5 — Qualification and fixture composition

Extract staging qualification coordination from `qualifyCloudAgent.js`. Split FI Agent Twin frontend, authentication, job service, persistence, and oracle behavior behind the existing `FixtureProvider` contract. Keep the provider as lifecycle composition. The driver receives no oracle credentials or hidden scenario state.

## Acceptance gates

- Compare receipts, durable state, cancellation, resume, and reconciliation before and after each extraction.
- Exercise browser and API effects through the same authorized executor.
- Compare MCP and HTTP behavior for the same run contract.
- Keep model calls within the same durable per-run inference budget.
- Preserve native CDP control and independent fixture oracles.
- Run the focused suites and the repository's full test command in a disposable environment.
- Make each stage independently reviewable and commit it separately.

Each extraction must preserve the existing behavioral contract. Record unresolved gaps as such; unit tests do not establish live staging qualification.
