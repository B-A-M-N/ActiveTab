# Desktop Test Display Map

Observed on 2026-10-19 with `xrandr --query` on `DISPLAY=:1`:

| Role | Output | Resolution | Desktop position | Primary |
|---|---|---:|---:|---|
| Main screen | `eDP-1` | 2880×1620 | `0,0` | Yes |
| Secondary screen | `HDMI-1` | 2560×1440 | `2880,0` | No |

The `HDMI-1` output is the requested screen for current headed browser testing and the default for ActiveTab-owned Chrome windows. The physical HDMI-1 origin is x=2880. Chrome reports a device scale factor of 2 on this desktop, so its device-independent window coordinate is x=1440. A headed Chrome placement probe confirmed CDP bounds at x=1440 correspond to X11 window geometry at x=2880 on `HDMI-1`.

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

For constrained headless regression runs, use `ACTIVETAB_HEADLESS=1 npm run test:isolated`. The harness runs the same `node --test` discovery and serial options with `DISPLAY` unset; compatible real-Chrome tests launch `--headless=new`. The two tests that assert desktop window coordinates explicitly skip in headless mode and must be run on a display. The full extension UI scenario remains opt-in. Its headless subset can be run with `ACTIVETAB_HEADLESS=1 ACTIVETAB_EXTENSION_INTEGRATION=1 npm run test:isolated -- test/extension.integration.test.js`; it checks explicit popup grants for exact tabs, Native Messaging, target-scoped observation, and the protected-route cookie oracle. Headless Chrome sometimes ignores CDP mouse input to the extension popup, so this subset falls back to a CDP `Runtime.evaluate` with `userGesture: true` to invoke the popup button handler. That checks the extension consent handler in a browser gesture context but does not prove a physical toolbar click. The headless subset ends before planner navigation, frame/workflow and restart lifecycle scenarios, benchmark matrix, desktop window placement, and DevTools keyboard interaction; the standard headless suite covers its own CDP and navigation fixtures, while those extension-specific UI and lifecycle scenarios still require the headed opt-in. Private Xvfb lacks an EWMH window manager here, and the visible popup click remained intermittent there despite direct focus, so that path is not reported as passed.

`launchOwnedChrome()` applies the selected position through `Browser.setWindowBounds` and verifies the resulting bounds before the app URL loads. Reuse and exact-target reattachment also apply and verify the configured position on their explicitly owned profiles. For independent verification, compare `window.screenX * window.devicePixelRatio` with the physical monitor origin; on this desktop the secondary begins at x=2880. Recheck `xrandr --query` if monitors are reconnected, rotated, or change resolution.
