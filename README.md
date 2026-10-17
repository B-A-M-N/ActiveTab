# ActiveTab

ActiveTab is a standalone, local-first browser-navigation runtime built on Chromium's native Chrome DevTools Protocol (CDP). It keeps browser connectivity separate from goal interpretation and exposes a small MCP server for agent harnesses. It does not use Playwright and has no runtime package dependencies.

The runtime supports three native CDP transports: an already-exposed loopback endpoint for dedicated browser processes, Chrome's opt-in existing-profile bridge for Chrome 144+, and an MV3 extension/native-messaging adapter for existing tabs. The extension route requires a separate **Attach to this tab** click for every page. It retains up to eight concurrent, target-scoped grants; one tab's detach or navigation session does not replace another. MCP operations accept `targetId` and require it whenever more than one browser session is attached.

## Requirements

- Node.js 22 or newer (uses built-in WebSocket and `fetch`).
- Chromium or Google Chrome with a loopback remote-debugging endpoint for manual use.

## Run

```sh
npm test
npm start -- targets --endpoint http://127.0.0.1:9222
npm start -- observe --target TARGET_ID --endpoint http://127.0.0.1:9222
npm start -- run --target TARGET_ID --goal "Open the account page" --journal .activetab/task.json --workflow-store ~/.local/share/activetab/workflows.json
npm start -- run --target TARGET_ID --goal "Search for blue shoes" --journal .activetab/search.json
npm start -- resume --journal .activetab/task.json --goal "Open the account page" --endpoint http://127.0.0.1:9222
npm start -- resume --journal .activetab/search.json --goal "Search for blue shoes" --endpoint http://127.0.0.1:9222
npm start -- targets --auto-connect
npm start -- observe --target TARGET_ID --auto-connect
```

For an existing Chrome profile, first enable Remote Debugging at `chrome://inspect/#remote-debugging`. `--auto-connect` reads only Chrome's `DevToolsActivePort` endpoint file, opens its browser-level WebSocket with native CDP, then enumerates page targets after Chrome's permission prompt is accepted. Use `--user-data-dir PATH` or `ACTIVETAB_CHROME_USER_DATA_DIR` for a non-default profile. The CLI requires an interactive target-ID confirmation; non-interactive sessions require `ACTIVETAB_AUTHORIZED_TARGET_ID` set out of band after explicit consent. The agent cannot authorize itself by supplying a target ID.

The integration tests launch isolated Chrome processes with temporary profiles and loopback fixtures, including direct CDP and nested OOPIF cases. They do not use a user's normal browser profile and do not contact BrowserAct SaaS. Chrome integration tests launch headed by default; headless mode requires explicit `ACTIVETAB_HEADLESS=1` and is never a silent fallback. The extension integration test additionally requires `ACTIVETAB_VISIBLE_CHROME=1`.

To run the full suite in **visible Chrome windows** (not headless), use:

```sh
npm run test:headed
```

This starts a virtual X display (Xvfb) so that Chrome renders into a real X server (not headless mode). The latest verified run on Chrome 150.0.7871.114 passed **221 tests, 220 passed, 0 failed, 1 skipped**.

For headed Chrome with a visible desktop display, use:

```sh
ACTIVETAB_VISIBLE_CHROME=1 npm test -- --test-concurrency=1
```

## FreeInference Staging and Cloud Agent

Cloud Agent is an application realm **within the FreeInference staging platform** (`https://staging.freeinference.org` → `/agents/`), not a localhost application. ActiveTab operates the real staging website in an authorized headed browser; backend diagnostics are a separate, optional path. The three paths are distinct:

| Path | Endpoint | Role |
|------|----------|------|
| Browser | `https://staging.freeinference.org` | The actual application under test |
| Control | CDP / extension broker | Transport only — never the application |
| Diagnostic | `ACTIVETAB_CLOUD_AGENT_URL` | Optional authorized backend records |

Loopback is **transport infrastructure only**. A locally forwarded address (SSH tunnel) is never the browser entry point and never counts as staging qualification.

### Browser qualification (application path)

Attach to an authorized headed Chrome tab on the real staging origin and run:

```sh
node --test test/cloud-agent-e2e.test.js
```

The test verifies environment/application identity from the observed URL, discovers the Agents application through live navigation, and — when authentication is required — enters a **durable resumable waiting state** instead of skipping the browser workflow. No step restarts from the beginning once the human action is verified. See `examples/cloud-agent/*.json` for goal-driven test packs.

### Backend diagnostics (optional diagnostic path)

ActiveTab can collect privileged backend diagnostics from a Cloud Agent control plane (direct or via a verified SSH tunnel). Set both environment variables to enable it:

```sh
ACTIVETAB_CLOUD_AGENT_URL=http://127.0.0.1:18000
ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN=<the Cloud Agent ADMIN_TOKEN>
# A loopback URL additionally requires the tunnel transport and verified remote target:
ACTIVETAB_CLOUD_AGENT_TRANSPORT=ssh_tunnel
ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET=<staging-host>:18000
```

When configured, the MCP server and local API server automatically register the following diagnostic sources alongside browser CDP evidence:

| Source | Description |
|--------|-------------|
| `cloud-agent-runs` | Recent agent run execution records |
| `cloud-agent-steps` | Per-step execution telemetry |
| `cloud-agent-usage` | Aggregated model usage and cost attribution |
| `cloud-agent-audit-log` | Administrative audit trail entries |
| `cloud-agent-sandboxes` | Active sandbox instances and their health |
| `cloud-agent-conversations` | Recent agent conversation records |
| `cloud-agent-measurements` | Operational profiling measurements |
| `cloud-agent-settings` | Current service configuration (non-secret fields only) |

If Cloud Agent runs on a different machine, use an SSH tunnel:

```sh
ssh -f -N -L 18000:127.0.0.1:18000 -L 13002:127.0.0.1:13002 bamn@<cloud-agent-host>
```

The adapter queries `ACTIVETAB_CLOUD_AGENT_URL` over HTTP with the admin token and extracts per-day usage records, redacted settings definitions, and run/step/sandbox/conversation records. It reports `available` or `empty` (never fake success) and includes stable evidence IDs (`admin:<source-id>`) for correlation.

To run only the extension vertical slice visibly, use:

```sh
ACTIVETAB_VISIBLE_CHROME=1 node --test test/extension.integration.test.js
```

This opt-in test opens Chrome visibly with a disposable profile, loads the unpacked extension, separately authorizes two tabs through the toolbar popup, navigates both through independent target-scoped sessions, and verifies detaching one leaves the other usable. It restores both leases after a forced service-worker restart, then continues the fixture workflow through nested out-of-process frames, records and replays a verified workflow without a planner call, injects and recovers from a stale-element failure, resumes from a task journal, and recovers from broker restart. It later closes the attached tab and restarts Chrome before requiring fresh explicit Attach clicks. The test also opens docked DevTools on the attached page. On the tested Chrome 150 build, DevTools left the extension lease active. It does not use or modify the user's normal Chrome profile. After browser restart, the test loads the unpacked extension into that profile again through CDP; it does not verify persistent extension installation without that reload.

## Existing-tab extension

1. Run `npm run native-host:setup -- --dry-run` to inspect the exact Native Messaging manifest path and contents. Add `--apply` only when you want to register the local host in that Chrome installation. Existing different manifests are left untouched.
2. In Chrome, open `chrome://extensions`, enable Developer mode, and load `/home/bamn/ActiveTab/extension` as an unpacked extension.
3. Start `npm run mcp:extension` as the MCP stdio server. On each tab to authorize, click the ActiveTab toolbar icon, then **Attach to this tab**. Each granted page appears in `list_tabs`; MCP can attach to each exact target after the extension reports its explicit click. Use `detach_tab` with that page's `targetId` to release one grant while preserving the others.

The repeatable visible benchmark is `ACTIVETAB_VISIBLE_CHROME=1 node --test test/extension.integration.test.js`. It launches disposable Chrome, runs the lifecycle/recovery/search scenario, then runs 30 tasks across ten generated loopback origins with varied semantic controls. It reports per-origin independent browser-state outcomes, selected-action checks, recovery counts, planner calls, engine latency, and approximate Chrome process-family CPU/RSS from asynchronous one-second Linux `/proc` snapshots. These are controlled fixtures; the matrix is not a sample of public websites and does not establish BrowserAct SaaS parity.

The extension has no content scripts and requests no site-wide host access. Its `chrome.debugger` permission is broad at the Chrome permission boundary; ActiveTab limits commands to the attached page and required CDP domains. Native Messaging connects through a per-user Unix socket with owner-only permissions. Closing the MCP process detaches the tab. The native host installer supports Chrome/Chromium on Linux and macOS; Windows registration is not implemented. Automated tests use disposable profiles and do not install this host in the user's Chrome configuration.

## Browser evidence

Observations retain bounded CDP network request/response metadata, page/DOM lifecycle events, and DOM mutation deltas alongside DOMSnapshot, accessibility, layout, frame, and screenshot evidence. They also expose visible viewport and nested scroll regions through compact `scrollTargets` and the selectable `scrollTargets` evidence facet. `get_evidence` retrieves selected facets by evidence ID. Request/response headers and request bodies are never captured. Response bodies remain in a bounded CDP buffer and are fetched only for one selected request with `inspect_network_response`; it returns no body unless the caller explicitly sets `includeSensitive:true`, and it caps returned content at 256 KiB. URL user-info, query, and fragment data, form values, and changed page text are redacted by default; `includeSensitiveUrlData`, `includeSensitiveFormValues`, and `includeSensitivePageText` are separate explicit retrieval options. Screenshots are returned only when requested. Clicks scroll an observed target into view, then revalidate its identity, visibility, label, and occlusion before dispatching native input. When a requested item is not currently rendered, the planner can select a uniquely relevant observed scroll region and dispatch a bounded native wheel event, then reobserve before planning again. Scrolls count against separate `maxScrolls` and total action budgets, stop if the region fails to move, and can be saved in version 2 workflows when replay can validate a fresh unique region, starting position, and visible-candidate state before and after movement.

MCP callers can request retained screenshot evidence with `get_evidence` and `includeScreenshot: true`; ActiveTab does not send those image bytes to its optional model endpoint. The caller decides whether to pass them to a model. `inspect_runtime_state` reads a caller-selected JavaScript own-property path (up to eight segments) from the main page or an attached OOPIF; it accepts no caller code, reports accessors without reading them, and asks V8 to reject operations it cannot prove side-effect-free. Sensitive values require `includeSensitiveValues: true`, are capped at 4 KiB, and require a second explicit `includeSensitiveRuntimeValues: true` to retrieve from retained evidence. Runtime records are bounded and remain separate from planner input. Same-process child-frame execution contexts and closure state are not yet selectable. An external agent can call `click_observed_element` with the target's evidence ID and backend node ID; ActiveTab requires the same candidate in a fresh observation, applies handoff and caller-intent checks, and returns post-action evidence without claiming the goal succeeded. The internal planner remains text-based. Open Shadow DOM controls and nested out-of-process iframe targets are observable and controllable through native CDP. OOPIF attachment is recursive, limited to 16 attached frame targets per tab, and each child keeps its own target-scoped node IDs. Child snapshots are captured one at a time within the remaining per-observation evidence budget; omitted frames are reported in observation coverage. Use the `outOfProcessFrames` evidence facet to retrieve their DOMSnapshot and accessibility data; pass `frameTargetId` with `backendNodeId` when requesting a selected element from a child target. Closed Shadow DOM content remains unavailable.

When `run_goal` finds tied targets, it returns `unresolved` without dispatching a click and includes the tied candidates' backend node IDs, frame target IDs, context, and bounds, linked to the retained evidence ID. An agent can inspect selected-element details or request the screenshot, then call `click_observed_element` for its chosen candidate. ActiveTab checks the candidate against a fresh observation and returns post-action evidence; the agent remains responsible for deciding from that evidence whether the task is complete. If evidence still does not distinguish the candidates, the task stays unresolved for human input.

## Search form input

Goals in the form `Search for <phrase>` use a local deterministic path: ActiveTab requires one visible main-frame `input[type=search]`, enters the caller's phrase with native CDP keyboard input, then clicks its matching search submit control. It verifies both a changed search-results state and the phrase in the visible search field or result text. Search phrases stay out of external planner calls, navigation results, task journals, and reusable workflows. Search workflows are not recorded. Task journals and tool results omit every raw goal; journals store a normalized fingerprint, and CLI `resume` requires the caller to re-enter the same goal, which ActiveTab verifies before observing or acting. Legacy redacted search journals without a fingerprint cannot safely resume. Other free-text fields, password fields, file inputs, and form values are not filled by this path.

## MCP

Run `npm run mcp` as an MCP stdio server. Set `ACTIVETAB_CDP_ENDPOINT` to a loopback endpoint, or set `ACTIVETAB_AUTO_CONNECT=1` to use Chrome's existing-session bridge. For auto-connect, enable Remote Debugging in Chrome and accept Chrome's permission prompt; set `ACTIVETAB_CHROME_USER_DATA_DIR` when using a non-default profile. Use `npm run mcp:extension` for the toolbar/native-host adapter; in that mode each extension Attach click supplies consent and no `ACTIVETAB_AUTHORIZED_TARGET_ID` is used. Tools are `list_tabs`, `attach_tab`, `detach_tab`, `observe_page`, `get_evidence`, `inspect_runtime_state`, `click_observed_element`, `inspect_network_response`, and `run_goal`. Session-scoped tools accept `targetId`; it is required whenever multiple tabs are attached. `run_goal` saves bounded, redacted task journals in ActiveTab's local state directory. On Linux this is `$XDG_STATE_HOME/activetab/mcp-tasks` or `~/.local/state/activetab/mcp-tasks`; macOS and Windows use their standard per-user application-state paths. Set `ACTIVETAB_STATE_DIR` to move all ActiveTab state, or `ACTIVETAB_TASK_JOURNAL_DIR` to use another absolute journal path. Repeating the same goal on the same target resumes an incomplete task, and a completed task returns idempotently. Pass `newTask: true` to start that goal again. Before each native action, ActiveTab atomically journals a redacted pending-action record; after a restart it takes fresh evidence, reconciles the uncertain action, and does not blindly replay the same target. Journals omit raw goals and browser evidence, use owner-only file permissions, cap each task record at 64 KiB, and retain resumable tasks when the configured 128-task capacity is full. Concurrent `run_goal` calls for one target are rejected while that target has an active navigation. Set `ACTIVETAB_WORKFLOW_STORE=/path/to/workflows.json` and call `run_goal` with `reuseWorkflows: true` to opt in to local workflow recording and replay.

## Human handoff

ActiveTab stops with `needs_human` when visible evidence strongly indicates an anti-automation challenge, a login route/prompt, or a visible password field. The result includes a handoff category and evidence ID. Complete the challenge or login manually in the authorized tab, then resume; ActiveTab does not attempt to solve or bypass it. On explicit resume, the journal records the original handoff evidence and fresh evidence that the detector no longer sees the condition, then clears the active handoff marker. This records observed state; it does not claim ActiveTab solved the challenge. Text and URL detection cannot identify visual-only challenges.

## Workflow reuse

CLI runs can opt in with `--workflow-store PATH`; use the same path for later runs and `resume`. MCP clients must set `ACTIVETAB_WORKFLOW_STORE` and pass `reuseWorkflows: true` to `run_goal`. Without those explicit settings, ActiveTab does not persist or replay workflows.

Only fully verified tasks are recorded. Version 2 replay resolves each saved click signature and scroll region against fresh visible evidence, validates the route and scroll position, compares visible-candidate fingerprints before and after scrolling, rechecks caller intent, and verifies the requested outcome. A stale route, target, list position, or candidate set invalidates the trace and continues through bounded fresh planning. Version 1 click-only workflows remain readable. Workflow files are capped and owner-only; they store hashes for goals, routes, labels, contexts, links, and candidate sets, plus structural region kind/tag/role and bounded scroll-position fractions. They omit raw labels, node identities, screenshots, form values, and authentication data.

## Optional model planner

The default local planner uses deterministic label overlap for simple tasks. An OpenAI-compatible endpoint can be selected with `ACTIVETAB_MODEL_ENDPOINT`, `ACTIVETAB_MODEL`, optional `ACTIVETAB_MODEL_API_KEY`, and `ACTIVETAB_MODEL_ALLOW_PAGE_CONTENT=1`. The last setting is required before page titles, headings, labels, and candidate facts are sent to that endpoint. Without it, the deterministic planner stays local even if endpoint details are configured.

## Investigation

See [the technical findings, architecture, REA edit plan, roadmap, and benchmark criteria](docs/engineering-plan.md), and [the real-Chrome Account-page screenshot](docs/assets/first-run.jpg).

![Real Chrome fixture after the resumed navigation reached the Account page](docs/assets/first-run.jpg) BrowserAct claims are evidence-labeled; no hosted SaaS task or parity benchmark was available.
