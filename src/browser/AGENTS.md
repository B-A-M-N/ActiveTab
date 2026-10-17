# ActiveTab Browser Control

## Purpose

Owns native CDP transport, target authorization, session lifecycle, and browser observations.

## Ownership

ActiveTab's browser control plane. Every effectful browser action ultimately dispatches here after passing the runtime policy boundary.

## Local Contracts

- No CDP target control without independently verified authorization.
- Stale document generations and revoked or detached leases fail closed.
- Closing a BrowserSession or restarting the MCP broker disposes only the local CDP session; the extension's explicitly authorized tab lease persists for same-browser-session reconnect. Only `detach_tab` or the extension's explicit Detach action revokes that lease.
- Candidates must match the current observation's target, document generation, and freshness state.
- Operator-prohibited control labels must be refused inside `BrowserSession.click()`, including calls that bypass planner admission.
- Playwright is prohibited as a control or observation dependency.
- Direct CDP is for a caller-selected target; it never attaches to a default browser profile automatically.
- Loopback CDP endpoints must be validated; browser application URLs are never loopback.

## Work Guidance

- Target authorization must be independent: a target ID cannot authorize itself.
- `resolveAuthorizedTarget` requires separate `targetId` and `confirmedTargetId`; both must match, and the confirmed value must originate from an independently established grant.
- Attached mode requires an operator-supplied `ACTIVETAB_AUTHORIZED_TARGET_ID` or extension Attach grant.
- Owned disposable Chrome may authorize its newly created target by the explicit operator request to launch that browser.
- Reused owned profiles must discard stale `DevToolsActivePort` metadata before launch and retain the profile only when explicitly requested.
- Do not lower freshness, visibility, or occlusion checks to make tests easier.

## Verification

```bash
node --test test/targets.test.js test/cdp.integration.test.js
```

CDP integration tests require a headed or Xvfb Chrome environment; `ACTIVETAB_HEADLESS=1` is explicit opt-in, never a silent fallback.

## Child DOX Index

No child DOX boundaries.
