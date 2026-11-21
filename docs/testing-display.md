# Desktop Test Display Map

Observed on 2026-10-19 with `xrandr --query` on `DISPLAY=:1`:

| Role | Output | Resolution | Desktop position | Primary |
|---|---|---:|---:|---|
| Main screen | `eDP-1` | 2880×1620 | `0,0` | Yes |
| Secondary screen | `HDMI-1` | 2560×1440 | `2880,0` | No |

This is a historical display map, not proof that HDMI-1 is available to every session. During the 2026-10-20 qualification run there was no usable second virtual display. Private Xvfb was available for headed-mode regression, but it had no EWMH window manager and was not visible on a physical display.

When available, `HDMI-1` is the requested screen for visible headed browser testing and the default target for ActiveTab-owned Chrome windows. The recorded physical origin is x=2880. Chrome reported a device scale factor of 2 on that desktop, so its device-independent window coordinate was x=1440. A headed Chrome placement probe confirmed CDP bounds at x=1440 corresponded to X11 window geometry at x=2880 on `HDMI-1`.

Set the persistent project-local choice in `.env.local`: use `ACTIVETAB_CHROME_DISPLAY=secondary` for HDMI-1 or `ACTIVETAB_CHROME_DISPLAY=main` for eDP-1. The tracked `.env.example` shows the setting; `.env.local` is ignored by Git. ActiveTab's CLI, MCP, API, qualification, and benchmark commands read it. A shell-provided `ACTIVETAB_CHROME_DISPLAY` overrides it. Test commands do not load `.env.local`; visible test commands default to secondary, and `npm run test:on-main` / `npm run test:on-secondary` force a screen for that run. `ACTIVETAB_CHROME_WINDOW_POSITION=x,y` remains an exact-position override.

The setting applies to newly launched owned Chrome, and is reapplied when ActiveTab reuses or reattaches to a browser in an explicitly configured ActiveTab-owned profile. It does not reposition a user's browser attached through the extension or default-profile auto-connect, and it never changes display modes. Tests that explicitly request headless Chrome remain headless and have no visible window.

This setting positions the Chrome window. The desktop dock or taskbar indicator is positioned by the desktop shell and is not moved with the browser window.

The defaults are `ACTIVETAB_CHROME_DISPLAY=secondary`, `ACTIVETAB_CHROME_MAIN_POSITION=0,0`, and `ACTIVETAB_CHROME_SECONDARY_POSITION=1440,0` in Chrome device-independent desktop coordinates. Override either position if the monitor arrangement or desktop scaling changes. Test commands do not load `.env.local`: `npm test` uses private Xvfb, while `npm run test:headed` uses the current desktop and defaults owned Chrome to the secondary display. `npm run test:on-secondary` and `npm run test:on-main` pin visible test windows to a selected display.

Examples:

```bash
npm test
npm run test:isolated
npm run test:on-secondary
npm run test:on-main
npm run test:headed -- --xvfb
ACTIVETAB_CHROME_DISPLAY=secondary npm run benchmark:response-inspection
ACTIVETAB_CHROME_DISPLAY=secondary npm run benchmark:semantic-observation
```

`npm test` and `npm run test:isolated` run headed Chrome inside a private virtual X display at `(0,0)`, isolated from the physical pointer and both monitors; Chrome is not visible on HDMI-1 in that mode. They do not load `.env.local` into test processes. A visible headed run uses CDP-generated page input, which does not move the physical pointer, but the desktop may focus the Chrome window. Use `npm run test:on-secondary` when you need to inspect the real browser window on HDMI-1.

When no usable display is available, run the full local suite in headless mode with `ACTIVETAB_HEADLESS=1 npm run test:isolated -- --test-concurrency=1`. This preserves the same `node --test` discovery and serial execution; compatible real-Chrome tests use `--headless=new`. It skips checks that require desktop window coordinates. Live and staging qualification remain headed-only and never silently fall back to headless.

The paired full-suite run on 2026-10-20 discovered 927 tests in both modes. Headless passed 922, failed 0, and skipped 5 in 177.79 seconds; private-Xvfb headed passed 923, failed 0, and skipped 4 in 216.32 seconds. All tests shared by both modes had the same result. The one pass-count difference is a desktop-bounds check that headless skips. Shared skips were the staging session (fetch failed; no authorized session at the time of that earlier run), the opt-in extension scenario, the unconfigured second provider, and the secondary-display reuse check. A separate authenticated headed staging-entry run later reached the real task composer; it is recorded below. Full-suite wall time is not a performance comparison because host load varied.

The opt-in headless extension subset passed twice (1/1 each run, 6.8 and 6.45 seconds). It grants two exact tabs through the extension consent handler, checks Native Messaging and target-scoped observation, and verifies the protected-route cookie oracle. In headless mode the popup button falls back to a CDP `Runtime.evaluate` call with `userGesture: true`; this exercises the handler in a browser gesture context, not a physical toolbar click. It ends before planner navigation, frame/workflow and restart lifecycle scenarios, benchmark matrix, desktop placement, and DevTools keyboard interaction.

The same opt-in extension scenario was attempted twice in headed Chrome inside private Xvfb and did not complete. On the first attempt, the popup opened and Attach was enabled, but the click did not create the broker grant. On the second, popup consent and the second tab grant succeeded, then planner navigation returned `unresolved` because the requested visible target was not found. Both attempts reported that Xvfb had no EWMH window manager and used direct X focus. These runs establish an environment-specific qualification gap; they do not prove that headed extension operation is impossible. Physical toolbar input, desktop focus, compositor behavior, and physical window placement were not verified.

The headless test wrapper selects the same main-screen coordinate defaults as the private-Xvfb headed wrapper, keeping shared Chrome launch arguments aligned. For a direct browser workload comparison, run the response benchmark in both modes with the same Chrome build and machine:

```bash
xvfb-run -a env ACTIVETAB_CHROME_DISPLAY=main node scripts/benchmark-response-inspection.mjs
env -u DISPLAY ACTIVETAB_HEADLESS=1 ACTIVETAB_CHROME_DISPLAY=main node scripts/benchmark-response-inspection.mjs
```

That benchmark explicitly sets the page viewport to 1280×720 at device scale 1 and emulates screen dimensions of 1280×1024 in both modes. It reports Chrome startup time, page visibility, response-inspection timings, Node CPU, and sampled Node/Chrome memory. Repeat interleaved pairs and compare per-case distributions; a single run is too noisy to establish a performance difference. ActiveTab uses Chrome's unified `--headless=new` mode ([Chrome Headless documentation](https://developer.chrome.com/docs/automation-and-testing/headless)). Headless still has no desktop window manager, physical monitor, toolbar surface, or physical window bounds. The shared navigation and observation code is exercised in both modes, while browser scheduling and rendering can produce timing differences. Use headed Chrome for behavior that depends on a real desktop surface.

Three interleaved response-inspection pairs were measured on 2026-10-20 with Chrome 150.0.7871.114 and identical fixture payloads and geometry. Every response status and reason code matched. Median Chrome startup was 1,978 ms headless and 2,625 ms headed; median Chrome process-tree peak RSS was 1,223 MiB and 1,361 MiB. Node peak RSS and heap were effectively equal (about 140 MiB and 53 MiB). Per-case median inspection time in milliseconds (headless / headed) was: 64 KiB JSON 208/190; 256 KiB JSON 328/358; near-CDP-buffer JSON 388/280; many-token JSON 1,002/976; deep nesting 9/15; many lines 24/22; over-limit JSON 2.5/3.4. Per-case timing direction was mixed and ranges overlapped broadly. Host pressure increased during this series (CPU and memory pressure both rose), so these measurements show no repeatable headless-specific bottleneck and do not establish exact performance equality. The user goal is to keep headless as close to 1:1 performance parity with headed as feasible; repeat under lower host pressure before tuning a case-specific path.

For an end-to-end local navigation comparison, run the API-to-CDP fixture in both modes with the same Chrome binary and `ACTIVETAB_CHROME_DISPLAY=main`:

```bash
ACTIVETAB_HEADLESS=1 npm run test:isolated -- test/api-cdp-integration.test.js
npm run test:isolated -- test/api-cdp-integration.test.js
```

The shared wrapper selects the same main-display window-position setting for both modes; the only browser-mode argument difference is `--headless=new`. The fixture waits for its local request, DOM-mutation, and lifecycle counts to settle, then requires a stable observation before running the same one-action Archive workflow. It asserts the terminal status, verified result, action count, and final page. The test logs `observationDurationMs`, `captureDurationMs`, per-CDP-method count/total/max latency, local index/candidate/semantic processing time, DOM/AX work counts, successful DOM-subscription refreshes, coherence retries, candidate count, and capture status.

A three-pair interleaved run on 2026-10-20 used Chrome 150.0.7871.114 in both modes. All six runs completed one action and reached the verified Archive page, with the same 1280×720 viewport, 1× device scale, 1280×1024 emulated screen, 162 DOM nodes, 105 accessibility nodes, 11 CDP round trips, and 25 candidates. Median API fixture duration was 3.48 s headless and 4.57 s headed; median task duration was 2.80 s and 4.12 s. Median observation duration was 157.6 ms and 193.8 ms; final capture was 89.1 ms and 98.4 ms. Headless had zero coherence retries in one run and one in two runs; headed retried once in all three. This local fixture showed no headless performance penalty, but the three pairs and changing host pressure do not establish universal or exact parity. The final full-suite pair recorded one API-fixture run per mode with identical outcomes and work counts; its observation/capture durations were 160.46/75.77 ms headless and 276.85/133.95 ms private-Xvfb headed.

A later live staging qualification reused the authenticated persistent Chrome profile, followed the observed Agents link, and verified the real task composer in headed Chrome. Run `df88eb60-a396-4404-8cac-7834750b4a34` records the result at `.activetab/qualification/df88eb60-a396-4404-8cac-7834750b4a34.report.json`. The route uses native CDP and the same TestRunner authorization path as fixture runs; staging qualification itself remains headed-only. Headless equivalence is supported by shared local suite and benchmark workloads, not by a headless staging run. The exact pathname guard was added after the headed run and is covered by selector regressions; the earlier read-only inventory confirmed the live Agents link pathname `/`.

`launchOwnedChrome()` applies the selected position through `Browser.setWindowBounds` and verifies the resulting bounds before the app URL loads. Reuse and exact-target reattachment also apply and verify the configured position on their explicitly owned profiles. For independent verification, compare `window.screenX * window.devicePixelRatio` with the physical monitor origin; on the desktop mapped above, the secondary began at x=2880. Recheck `xrandr --query` if monitors are reconnected, rotated, or change resolution.
