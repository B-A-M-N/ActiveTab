# ActiveTab Runtime Architecture

## Purpose

Native CDP runtime and navigation components for the ActiveTab browser automation platform.

## Ownership

ActiveTab's core execution layer. Contains the browser control plane, runtime policy boundary, testing engine, and diagnostic adapters.

## Local Contracts

- Effectful browser operations dispatch through `src/runtime/authorizedExecutor.js`, which applies policy admission before CDP dispatch.
- Browser sessions own freshness, target validity, and lifecycle checks; the authorized executor owns action policy.
- Failure investigation runs read-only checks. It may inspect durable operation reservations, receipts, scoped correlation links, and later evidence; it never replays the failed workflow step, and uncertain effects remain unreconciled until the run coordinator verifies them.
- Operator causal diagnostics use the earliest sequence-ordered typed contract failure, not advisory model/reviewer errors or exception-message guesses. Stable failure codes, phase, evidence references, safe next action, and continuation disposition remain explicit and recursively decomposable in Markdown.
- The extension broker's process/session shutdown is transport teardown, not consent revocation. It preserves the extension's explicit tab leases for same-browser-session reconnection; only an explicit detach releases a lease.
- Application-specific logic belongs in profiles or integration adapters, not in generic navigation, policy, or browser execution paths.
- `environments/model.js` resolves application identity by the profile-declared route and authentication realm. Browser diagnostics, workflow scope, and continuation bindings must use the current observed URL; same-origin applications are not interchangeable.
- `buildEphemeralCurrentOriginBinding()` is a run-local navigation scope only. The CLI must obtain exact-origin operator consent (or an out-of-band exact-origin grant for non-interactive runs); the binding contains one observed origin, has no workflow operation IDs, and is never stored as a reusable profile.
- `navigation/ApplicationRunService` is the shared HTTP/MCP composition boundary for navigation and declarative workflow runs; adapters retain session selection and response handling, while authorization and durable lease enforcement remain in the runtime and `TestRunner`.
- The MCP `get_runtime_capabilities` projection reports live target attachment and current scope requirements, but provider readiness comes from authenticated model-catalog metadata only. It must label that source and never claim that inference was probed unless an actual provider call was made.
- Reusable site capabilities require fresh observed evidence, a trusted field policy, fixture qualification, and exact origin/environment/application/route/principal scope. Workflow input cannot define its own effects, data sensitivity, qualification evidence, or endpoint.
- API template inputs reject fields not declared by the typed input schema. Durable task records retain only structure-preserving redacted input projections; live workers receive the caller's original values through the in-process run closure, and older persisted task records are sanitized on load.
- HTTP application discovery receives its knowledge-store path, environment binding, and stable principal only from trusted server composition. Reusable knowledge is keyed by canonical origin, environment, matched application, authentication realm, and principal; unmatched or ambiguous scope skips persistence. Version 1 unscoped entries are migration data and are never reused. The store root is canonical and owner-private; request bodies cannot select paths or identity scope, and retention or clear only remove identity-validated store entries.
- CDP commands may set a per-command deadline or abort signal. Expiration or abort removes the local pending-result association; it does not claim that Chromium canceled the command, and unmatched late replies must not affect newer requests or observations.
- Selected network-response inspection is opt-in by exact evidence, target, and request ID. A target change makes the evidence stale before cached data can be read or CDP can be queried. MCP returns the bounded, content-aware body projection with recognizable credentials redacted, plus Markdown section/block indexes and source offsets; it never returns headers or sensitive URL data. A trusted local caller may separately request complete credential values. MCP requires an independent operator grant for raw credential values, screenshots, full form values, and sensitive runtime values. Markdown is the normalized, byte-addressable diagnostic report; typed parse results, repair diagnostics, and source view remain separate. Paging navigates the complete selected view and never silently truncates it.
- MCP sensitive evidence request and release flows are owned by `src/mcp/evidenceReleaseTools.js`. Each release is bound to the exact attached target, retained evidence, local profile application, principal, and MCP process. Response credential values require separate matching body and credential grants; the body is not read until all grants verify, and the actual returned MCP representation is charged before success.
- MCP browser handlers are composed from trusted server-owned sessions, lease storage, and decision runtime. Tool arguments may select an authorized target and evidence, but cannot supply sessions, leases, attachment grants, or alternate browser execution paths. Tab attach/detach preserves the extension's explicit per-tab consent lifecycle.
- Selected runtime strings are available only through explicit trusted local inspection. Long values are returned in bounded, UTF-16-safe pages with length and continuation metadata, so the caller can reconstruct the full value without a silent cap; MCP always returns redacted runtime metadata.
- Browser observations default to the interaction profile without screenshot capture. Callers that only need route and lifecycle state use `lightweight`; `structural` captures DOM/AX/frame evidence without deriving action candidates; `visual` adds a screenshot. Interaction and visual observations include a bounded semantic-page v3 projection of page shape, regions, forms, collections, table and repeated-record items, and controls. Table and repeated-item evidence binds visible controls to their nearest exact record when the structural group is unique. Fields carry evidence-linked labels and conservative semantic roles when explicit markup or stable structural names support them; uncertain roles remain unknown. Each semantic fact is marked observed, inferred, or unknown; native interaction mechanics describe browser control types only, while application operation meaning and effect remain unknown unless trusted code supplies them. Candidate coverage reports actual observed, returned, and omitted counts. Navigation may pass a task goal for local candidate ranking; that goal is not sent to a provider by observation or ranking. Model-facing semantic projections accept v1 and v2 inputs for compatibility and emit the bounded v3 shape.
- Structured extraction can return a one-shot `observed_partial` result from freshly retained DOM evidence after trusted field classification, read, and release policy checks. In addition to tables, a synthesized read goal may use semantic roles to select fields from one uniquely matched repeated-card group; its observation, frame, document, group, and ordered field-source bindings must match local semantic evidence. This path does not qualify or register a capability and never claims page-level completeness. Reusable extraction still requires a registered typed contract. Pagination is available only through an explicitly trusted same-origin, same-path policy and dispatches each page advance through `BrowserStepHandler` and the authorized executor.
- Extraction outputs remain incomplete unless their declared exact-count or pagination-exhaustion contract, typed schema, uniqueness, field provenance, and release policy all pass. Raw extraction values are not placed in receipts or durable task journals. MCP may retain a verified, policy-released result in a separate owner-only artifact file, bound to its target, environment, principal, typed intent, and qualified capability-manifest fingerprints; replay checks the current capability registry, release policy, and extraction verification again. Mid-run extraction progress remains resumable only as unresolved work and must be rebuilt after interruption.
- All authorization boundaries are enforced by code, not documentation.
- Semantic model output is only a candidate annotation from a configurable structured OpenAI-compatible service (FreeInference Production model ID `glm-5.3-flash` by default). Jev is a built-in pinned reviewer whose output never grants authority or verifies success; a Jev disagreement may pause dispatch for agent review.
- Semantic and Jev predictions share stable observation/decision lineage but remain distinct, append-only telemetry events.
- The decision runtime is wired into CLI navigation, MCP goals and observed-element actions, API navigation/discovery/test runs, and the staging qualification workflow. Jev reviews selected decision boundaries; ordinary field entry/selection records an explicit skipped-review event. Missing Jev credentials or refusal is logged as advisory and does not stop deterministic local execution.
- MCP test-run status reads reflect the settled receipt, and resume reuses the exact workflow and browser session bound to that run.
- The HTTP API awaits one shared durable intervention-store initialization promise before listening; an initialization failure prevents readiness and is surfaced as `intervention_store_unavailable`, never as an empty healthy store.
- Application adapters translate caller-authored typed requests into generic workflows. Their process-local operation authorizers are injected by trusted composition code and cannot be supplied through workflow JSON.
- `navigation/outcomeVerifier.js` checks fresh visible destination evidence only; it cannot authorize actions or verify application-level effects.
- The MCP `enter_cloud_agent` primitive starts from an explicitly attached, currently observed staging tab, follows visible Agents/Cloud Agents navigation, and verifies the task composer on the same target. It may suspend for human authentication; it never creates a Cloud Agent task. `start_cloud_agent_task` still requires exact caller-supplied inputs.
- CLI navigation loads trusted local environment bindings with `--profile ID`; the task journal binds resume to the same environment fingerprint. Supplying no profile never grants cross-origin navigation.

## Work Guidance

- When changing authorization behavior, run adversarial tests across every execution entrypoint.
- Read the nearest child DOX chain before editing a subtree.
- Do not weaken security checks to satisfy fixtures.

## Verification

```bash
node --test test/targets.test.js test/approvals.test.js test/authorized-executor.test.js test/goal-steps.test.js test/testing.test.js
node --test test/mcp-evidence-release.test.js test/mcp.test.js
```

## Child DOX Index

| Path | Purpose |
|------|---------|
| `src/browser/` | CDP transport, target authorization, and session lifecycle |
| `src/cdp/` | Loopback CDP WebSocket transport, per-command deadlines, and pending response lifecycle |
| `src/extension/` | Native Messaging broker and extension-backed CDP transport |
| `src/runtime/` | Policy, approvals, and execution boundary contracts |
| `src/navigation/` | Navigation planning, authorized execution coordination, recovery, and destination verification |
| `src/testing/` | Declarative workflows, receipts, and verification semantics |
| `src/diagnostics/` | Diagnostic contracts, evidence collection, and correlation |
| `src/navigation/semanticAnalyzer.js` | OpenAI-compatible, bounded page and control annotations |
| `src/decisions/` | Semantic inference, pinned Jev review, and advisory visual decisions |
| `src/telemetry/` | Append-only decision events and offline evaluation/export |
| `src/integrations/` | Application-specific workflow adapters over generic ActiveTab execution |
| `src/api/` | Local HTTP composition, routing, and server-owned persistence configuration |
| `src/api/routes/` | Incrementally extracted endpoint-family handlers; no alternate policy or run composition |
| `src/mcp/` | MCP tool composition, exact session selection, and separately granted sensitive evidence release |
| `src/mcp/browserTools.js` | Injected tab lifecycle and browser observation handlers; click dispatch remains behind the shared lease and authorized action path |
| `src/mcp/evidenceReleaseTools.js` | Profile-bound evidence-release requests, grant verification, data retrieval, and byte charging |
| `src/discovery/` | Evidence-driven application discovery and bounded persistent knowledge |
| `src/capabilities/` | Capability discovery, compilation, qualification, registry, and invocation contracts |
| `src/extraction/` | Typed record extraction, collection, provenance, verification, and release policy |
| `src/query/` | Bounded local semantic data queries and non-authorizing target lookup |
| `src/state/` | Bounded task journals, resumable workflow state, and separately released local result artifacts |
| `src/observe/` | Retained browser evidence, semantic page compilation, content-aware network response inspection, credential redaction, and Markdown diagnostic views |
| `src/environments/` | Profile-built environment bindings and exact observed application/realm resolution |
| `src/qualification/` | Typed task intent and separately admitted remote live-site qualification |
