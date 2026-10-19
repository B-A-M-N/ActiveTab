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
- Candidate link projections may expose `opensNewTarget` as a boolean. Following a link that declares another target is refused by default because its browser behavior can create an unleased target. A trusted run may explicitly select same-target navigation for an observed root-frame anchor; the session revalidates the exact current destination, document generation, and lease before `Page.navigate`.
- `BrowserSession.observe()` defaults to the interaction profile and does not capture screenshots. Route/lifecycle-only work may request `lightweight`; structural inspection requests `structural`; screenshot evidence requires `visual` or the explicit `includeScreenshot:true` option. Only interaction/visual profiles produce fresh action candidates.
- Exact native field/selector verification may compare a caller-provided value inside the browser process, but only returns a boolean and never exposes the field value in observations or receipts.
- Filter checkbox control accepts only an exact caller-selected checked/unchecked state for a fresh native checkbox. It returns no field value and remains behind trusted profile operation authorization.
- ARIA combobox selection is a composite effect. It requires an executor-approved envelope limited to opening the exact observed combobox and selecting one exact visible option controlled by that still-open combobox; the executor rechecks target lease, page/application binding, and fresh candidate identity before each suboperation.
- Search, fill, and select value limits come from `actionLimits.js` and must match planning and workflow validation; oversized exact values are refused without truncation.
- `BrowserSession.typeSearchPhrase()` accepts native `input[type=search]` directly. An `input[type=text][name=q]` is accepted only when the exact fresh observation binds it to a same-origin GET form targeting the same browsing context. The observer projects only a derived `queryField` boolean, never the full attribute map. Submitter-level `formmethod`, `formaction`, and `formtarget` overrides are part of the observed effective form contract; only the central caller-bound search authorizer may admit its exact query and same-form submit.
- Operator-prohibited control labels must be refused inside `BrowserSession.click()`, including calls that bypass planner admission.
- Playwright is prohibited as a control or observation dependency.
- Direct CDP is for a caller-selected target; it never attaches to a default browser profile automatically.
- `launchOwnedChrome()` may apply an explicit `environmentProfile` only to a newly created owned browser. It starts at `about:blank`, records the actual `Browser.getVersion` and navigator/client-hint/platform/locale/timezone/viewport/WebGL/storage-permission environment, applies only explicit locale, timezone, geolocation, viewport, and language-header settings, then navigates to the validated startup URL. It does not spoof the user agent or grant browser permissions. Environment overrides are refused for attached, reused, or persistent browser profiles.
- Retained network activity stores bounded request/response timing, protocol, cache/reuse flags, and byte counters only. It does not retain response headers or bodies; selected body inspection reads that response from CDP on demand and redacts recognizable credentials before producing any view.
- A newly observed HTTP 429 may surface as a URL-free, status-only rate-limit signal. Callers must suspend and hand control to the operator; they must not retry, change identity, or bypass the site's limit.
- Loopback CDP endpoints must be validated; browser application URLs are never loopback.

## Work Guidance

- Target authorization must be independent: a target ID cannot authorize itself.
- `resolveAuthorizedTarget` requires separate `targetId` and `confirmedTargetId`; both must match, and the confirmed value must originate from an independently established grant.
- Attached mode requires an operator-supplied `ACTIVETAB_AUTHORIZED_TARGET_ID` or extension Attach grant.
- Owned disposable Chrome may authorize its newly created target by the explicit operator request to launch that browser.
- Chrome auto-connect target records retain the actual loopback HTTP endpoint for durable leases and CDP recovery. Their separate `journalEndpoint` keeps existing task journals addressable; never use that compatibility key as the lease or CDP endpoint.
- The startup-only `resolveOwnedBlankTarget()` path requires the live Chrome child process from that launch and its exact `about:blank` target. It does not make blank targets controllable in attached or reused browsers.
- For desktop qualification, set `ACTIVETAB_CHROME_DISPLAY=main|secondary` to select the configured monitor for all newly launched ActiveTab Chrome processes, including direct integration-test launches and the API runner. `ACTIVETAB_CHROME_MAIN_POSITION` and `ACTIVETAB_CHROME_SECONDARY_POSITION` override the default Chrome desktop coordinates (`0,0` and `1440,0` on the documented two-screen desktop). `ACTIVETAB_CHROME_WINDOW_POSITION=x,y` is an explicit coordinate override. Coordinates are device-independent pixels. Owned Chrome applies and verifies the bounds through CDP before startup navigation; other launches pass the same position to Chrome. No setting changes display modes or moves existing windows.
- Owned disposable Chrome cleanup first requests browser shutdown through its browser-level CDP client, then uses bounded TERM/KILL fallback only for that owned process. A temporary profile is removed only after process exit is confirmed; cleanup is verified only when both browser shutdown and profile removal are confirmed. Closing an ordinary `BrowserSession` remains a local CDP detach and does not close the browser or revoke an extension lease.
- Before launching with a persistent profile, probe its `DevToolsActivePort` and Chrome singleton lock. Never remove endpoint metadata while Chrome owns the profile; if the lock is live but the endpoint is unavailable, refuse without forwarding a startup URL into that browser.
- The manual `--open-only` flow may reuse an already-running owned profile only through its live CDP endpoint. Reuse must not navigate, select, or otherwise control a page, and releasing ActiveTab's CDP connection must leave Chrome and its profile open.
- Qualification may reattach to a live owned profile only with the caller's exact `--target-id` (or the exact target persisted by a suspended run). Reattachment validates the target's current origin against the profile allowlist before and after CDP attach, never navigates, and detaches without closing Chrome. If the exact target is unavailable or unauthorized, refuse without launching a replacement browser.
- Trusted navigation composition may recover a failed post-click observation only over the original loopback endpoint and exact target ID while the durable lease token remains current. It checks the authorized environment origin before and after attach, takes fresh evidence, and rebinds the replacement session to the same lease without changing its fencing token. It never repeats the click or substitutes another tab. Extension-managed transports use their broker reconnection path instead.
- Public live qualification adds an owned-process check and scenario-specific route allowlist to the shared exact-target reattachment contract.
- Do not lower freshness, visibility, or occlusion checks to make tests easier.

## Verification

```bash
node --test test/targets.test.js test/cdp.integration.test.js
```

Integration tests launch disposable Chrome headed by default. Test launch paths use `--headless=new` when the operator explicitly sets `ACTIVETAB_HEADLESS=1`; no launch path silently chooses a mode. The opt-in visible-extension test requires `ACTIVETAB_VISIBLE_CHROME=1` plus a desktop display and explicitly skips when headless mode is selected.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `actionLimits.js` | Shared exact-value size limits for browser dispatch and planning |
| `browserEnvironment.js` | Bounded environment configuration and pre-navigation initialization for newly owned Chromium targets |
| `targets.js` | Loopback CDP discovery, exact target authorization, and owned startup-target resolution |
| `targetReattachment.js` | Lease-bound recovery of one exact loopback CDP target with fresh post-navigation evidence |
