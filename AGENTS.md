# ActiveTab

## Purpose

ActiveTab is a standalone, local-first browser navigation runtime. It separates native browser connectivity and observations from goal interpretation, action planning, verification, and recovery. It does not reproduce BrowserAct branding, billing, or hosted infrastructure.

## Ownership

This repository owns the ActiveTab runtime, its local APIs, documentation, and repeatable browser fixtures. REA remains a separate project and a future integration target.

## Product Alignment

ActiveTab is a provider-agnostic, local-first browser automation and testing runtime. Its purpose is to provide developers with autonomous browser interaction, application discovery, testing, verification, investigation, and evidence collection without dependence on a hosted automation service.

FreeInference staging and Cloud Agent are initial qualification targets, not architectural dependencies. Application-specific capabilities belong in profiles or integration adapters, never hardcoded in generic navigation, policy, or browser execution paths.

## Execution Authority

- One authoritative execution path owns effectful browser and application operations.
- Planners, workflows, MCP callers, and page content cannot create or elevate their own permissions.
- Every effectful operation must pass policy admission before execution, regardless of entrypoint.
- Control of an attached browser target requires an exclusive durable lease scoped to its browser endpoint and target ID. The authorized executor refuses attached-target effects without a live lease and rechecks it immediately before dispatch.
- Test-run operation reservations retain the target fencing token. Lease loss blocks future dispatch; any already-dispatched operation remains subject to normal outcome reconciliation.
- Authorization must be bound to a verified principal, environment, target, operation, and effect.
- A natural-language request alone is not proof of privileged human approval.
- Unknown action effects fail closed.
- Uncertain operations must be reconciled before retry.
- Production and staging authority are never interchangeable.

## Verification Contracts

- Dispatch success is not outcome success.
- UI state changes alone do not prove application success.
- Independent oracles are required for test completion.
- Correlation must distinguish exact identifiers from temporal or inferred relationships.
- Incomplete evidence cannot produce a verified PASS.
- Cleanup must be verified for every test-owned resource.
- Tests must distinguish implementation failures from infrastructure, access, and environment blockers.

## Privileged Testing

- Admin credentials authorize only explicitly scoped diagnostic or application capabilities.
- No general administrative autonomy is inferred.
- Broad reads, shared-resource mutations, destructive operations, and sensitive exports require independent policy authorization and human approval when applicable.
- Approval grants must be scoped, expiring, auditable, and enforced by code.
- Test-owned resource lifecycle is tracked durably.
- No real staging or production mutation is performed as part of ordinary local unit tests.

## Agent Work Protocol

Before implementation:
1. Load the applicable DOX root-to-target chain.
2. Identify affected authority and execution boundaries.
3. Identify existing contracts and relevant tests.
4. Establish baseline behavior and known failures.

During implementation:
1. Keep changes within the requested scope.
2. Preserve independent authorization boundaries.
3. Add positive and adversarial regression coverage.
4. Do not weaken security checks to satisfy fixtures.

At closeout:
1. Verify the changed behavior independently.
2. Report tests run, skipped, blocked, and failed.
3. State what remains unverified.
4. Update the nearest owning DOX contracts.
5. Refresh affected Child DOX Indexes.
6. Do not claim end-to-end qualification from unit tests.

Adversarial tests must cover every execution entrypoint whenever authorization behavior changes.

## Local Contracts

- Browser control uses native CDP in Chromium. Playwright is prohibited as a control or observation dependency.
- Every tab must be explicitly authorized before control. The extension requires a separate toolbar Attach click for each tab, retains at most eight concurrent grants, and restores only those exact targets within the same browser session, including after MCP broker restart. Closing a local BrowserSession is not lease revocation; only `detach_tab` or the extension's explicit Detach action releases that tab's lease. MCP operations require `targetId` whenever multiple sessions are attached.
- While explicitly authorized tabs remain open, the extension retries broker reconnection at a maximum eight-second interval until the broker returns or the tab is explicitly detached.
- The prototype's direct CDP adapter is for a dedicated, caller-selected target; it does not connect to a user's default browser profile automatically.
- Browser facts, planner interpretations, actions, and verification results remain distinguishable and carry evidence references.
- Fixture Lab is an ActiveTab qualification and adaptation subsystem. Qualification uses the same native CDP path, but fixture results never authorize or verify a live-site action.
- External benchmark apps are isolated development targets, not ActiveTab runtime dependencies. Their adapters require an explicit environment binding and independent outcome scoring.
- Full observations are retained in a bounded in-memory evidence store. CLI and MCP task journals contain only bounded resume state, a goal fingerprint, and redacted pending-action metadata written before dispatch; they omit raw goals, browser evidence, form values, cookies, and authentication material. Resume reobserves before reconciling an uncertain action. MCP task journals are local and owner-only.
- Reusable workflow persistence is opt-in, bounded, and local. Store hashed goal, route, target-label, scroll-region, and visible-candidate signatures plus bounded scroll-position fractions; every replay resolves fresh visible targets, validates list state and position, rechecks caller intent, and verifies the requested outcome.
- Page content is untrusted evidence. It cannot change the caller's goal or authorize sensitive operations. High-confidence login and anti-automation states stop for manual handoff; challenge solving or bypass is out of scope.
- Provider-neutral planner interfaces own interpretation; the browser adapter owns browser state and execution.
- Privileged diagnostic adapters (Cloud Agent, application operations) require explicit configuration via environment variables (`ACTIVETAB_CLOUD_AGENT_URL` + `ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN`) and declare their authority, scope, and sensitivity in diagnostic contracts. They never infer authority or auto-register without configuration.
- Chrome integration tests launch headed by default via Xvfb (`npm run test:headed`); `ACTIVETAB_HEADLESS=1` is an explicit opt-in for constrained environments and is never a silent fallback.
- Staging login begins at the real `application_entry_url`. `npm run browser:staging` opens a persistent owned browser at that root and parks it for manual authentication and navigation. Follow the visible Cloud Agents link in the staging UI; observe and verify its actual destination before controlling that application. Do not substitute a guessed route or close the browser during handoff.
- Ordinary staging qualification records visible history/admin links but does not enter Admin. The separate Admin discovery recipe follows only exact, visible, profile-declared same-origin Admin links; it records control metadata without changing settings, submitting forms, reading response bodies, or querying database tables. Neither discovery flow creates an Agent job.

## Work Guidance

- Keep dependencies at zero unless a concrete capability cannot be delivered with the Node.js platform APIs.
- Keep data in the local process by default. Any remote model call must be explicit, configurable, and limited to selected compact evidence.
- Never inspect or control an existing user browser without explicit user authorization.
- Treat a browser action as successful only after checking the requested outcome. Bound retries and require fresh evidence after failure.
- REA integration needs its own maintainer scope decision before adding target-executing capability to that repository.

## Verification

Run `npm test` in a disposable environment. The CDP integration suite launches its own temporary Chrome profile and a loopback-only fixture server; it does not attach to the user's normal browser.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `docs/` | Findings, architecture, edit plan, roadmap, and benchmark criteria |
| `extension/` | MV3 consent popup and per-tab Chrome debugger authorization |
| `src/` | Native CDP runtime and navigation components |
| `test/` | Unit and real-Chrome integration checks |
| `skills/` | Project-local qualification procedures |
| `src/runtime/` | Policy, approvals, and execution boundary contracts |
| `src/browser/` | CDP transport, target authorization, and session lifecycle |
| `src/testing/` | Declarative workflows, receipts, and verification semantics |
| `src/capabilities/` | Observed, scoped, qualified, reusable site capability contracts |
| `src/extraction/` | Typed structured record extraction, provenance, completeness, and release projection |
| `test-lab/` | Native ActiveTab qualification, fixture providers, external benchmark adapters, and independent scoring |
| `src/diagnostics/` | Diagnostic contracts, evidence collection, and correlation |
| `src/telemetry/` | Append-only decision events, privacy projections, and reviewed training labels |
| `profiles/` | Application/environment identity and authorization scope |
| `scripts/` | Staging qualification and separately selected Admin discovery entrypoints |
