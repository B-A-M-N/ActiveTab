# ActiveTab Runtime Architecture

## Purpose

Native CDP runtime and navigation components for the ActiveTab browser automation platform.

## Ownership

ActiveTab's core execution layer. Contains the browser control plane, runtime policy boundary, testing engine, and diagnostic adapters.

## Local Contracts

- Effectful browser operations dispatch through `src/runtime/authorizedExecutor.js`, which applies policy admission before CDP dispatch.
- Browser sessions own freshness, target validity, and lifecycle checks; the authorized executor owns action policy.
- The extension broker's process/session shutdown is transport teardown, not consent revocation. It preserves the extension's explicit tab leases for same-browser-session reconnection; only an explicit detach releases a lease.
- Application-specific logic belongs in profiles or integration adapters, not in generic navigation, policy, or browser execution paths.
- Reusable site capabilities require fresh observed evidence, a trusted field policy, fixture qualification, and exact origin/environment/application/route/principal scope. Workflow input cannot define its own effects, data sensitivity, qualification evidence, or endpoint.
- Structured extraction reads visible retained DOM evidence. Pagination is available only through an explicitly trusted same-origin, same-path policy and dispatches each page advance through `BrowserStepHandler` and the authorized executor.
- Extraction outputs remain incomplete unless their declared exact-count or pagination-exhaustion contract, typed schema, uniqueness, field provenance, and release policy all pass. Raw extraction values are not placed in receipts or durable task journals.
- All authorization boundaries are enforced by code, not documentation.
- Semantic model output is only a candidate annotation from a configurable structured OpenAI-compatible service (default FreeInference Production `GLM5.3-flash`). Jev is a built-in pinned reviewer whose output never grants authority or verifies success; a Jev disagreement may pause dispatch for agent review.
- Semantic and Jev predictions share stable observation/decision lineage but remain distinct, append-only telemetry events.
- The decision runtime is wired into CLI navigation, MCP goals and observed-element actions, API navigation/discovery/test runs, and the staging qualification workflow. Jev reviews selected decision boundaries; ordinary field entry/selection records an explicit skipped-review event. Missing Jev credentials or refusal is logged as advisory and does not stop deterministic local execution.
- MCP test-run status reads reflect the settled receipt, and resume reuses the exact workflow and browser session bound to that run.
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
```

## Child DOX Index

| Path | Purpose |
|------|---------|
| `src/browser/` | CDP transport, target authorization, and session lifecycle |
| `src/extension/` | Native Messaging broker and extension-backed CDP transport |
| `src/runtime/` | Policy, approvals, and execution boundary contracts |
| `src/navigation/` | Navigation planning, authorized execution coordination, recovery, and destination verification |
| `src/testing/` | Declarative workflows, receipts, and verification semantics |
| `src/diagnostics/` | Diagnostic contracts, evidence collection, and correlation |
| `src/navigation/semanticAnalyzer.js` | OpenAI-compatible, bounded page and control annotations |
| `src/decisions/` | Semantic inference and pinned Jev review services |
| `src/telemetry/` | Append-only decision events and offline evaluation/export |
| `src/integrations/` | Application-specific workflow adapters over generic ActiveTab execution |
| `src/capabilities/` | Capability discovery, compilation, qualification, registry, and invocation contracts |
| `src/extraction/` | Typed record extraction, collection, provenance, verification, and release policy |
