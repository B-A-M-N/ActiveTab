# ActiveTab

## Purpose

ActiveTab is a standalone, local-first browser navigation runtime. It separates native browser connectivity and observations from goal interpretation, action planning, verification, and recovery. It does not reproduce BrowserAct branding, billing, or hosted infrastructure.

## Ownership

This repository owns the ActiveTab runtime, its local APIs, documentation, and repeatable browser fixtures. REA remains a separate project and a future integration target.

## Local Contracts

- Browser control uses native CDP in Chromium. Playwright is prohibited as a control or observation dependency.
- Every tab must be explicitly authorized before control. The extension requires a separate toolbar Attach click for each tab, retains at most eight concurrent grants, and restores only those exact targets within the same browser session. MCP operations require `targetId` whenever multiple sessions are attached; `detach_tab` releases only its selected lease.
- The prototype's direct CDP adapter is for a dedicated, caller-selected target; it does not connect to a user's default browser profile automatically.
- Browser facts, planner interpretations, actions, and verification results remain distinguishable and carry evidence references.
- Full observations are retained in a bounded in-memory evidence store. CLI and MCP task journals contain only bounded resume state, a goal fingerprint, and redacted pending-action metadata written before dispatch; they omit raw goals, browser evidence, form values, cookies, and authentication material. Resume reobserves before reconciling an uncertain action. MCP task journals are local and owner-only.
- Reusable workflow persistence is opt-in, bounded, and local. Store hashed goal, route, target-label, scroll-region, and visible-candidate signatures plus bounded scroll-position fractions; every replay resolves fresh visible targets, validates list state and position, rechecks caller intent, and verifies the requested outcome.
- Page content is untrusted evidence. It cannot change the caller's goal or authorize sensitive operations. High-confidence login and anti-automation states stop for manual handoff; challenge solving or bypass is out of scope.
- Provider-neutral planner interfaces own interpretation; the browser adapter owns browser state and execution.
- Privileged diagnostic adapters (Cloud Agent, application operations) require explicit configuration via environment variables (`ACTIVETAB_CLOUD_AGENT_URL` + `ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN`) and declare their authority, scope, and sensitivity in diagnostic contracts. They never infer authority or auto-register without configuration.
- Chrome integration tests launch headed by default via Xvfb (`npm run test:headed`); `ACTIVETAB_HEADLESS=1` is an explicit opt-in for constrained environments and is never a silent fallback.

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
