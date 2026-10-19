# Desktop Test Display Map

Observed on 2026-10-19 with `xrandr --query` on `DISPLAY=:1`:

| Role | Output | Resolution | Desktop position | Primary |
|---|---|---:|---:|---|
| Main screen | `eDP-1` | 2880×1620 | `0,0` | Yes |
| Secondary screen | `HDMI-1` | 2560×1440 | `2880,0` | No |

The `HDMI-1` output is the requested screen for current headed browser testing and the default for ActiveTab-owned Chrome windows. The physical HDMI-1 origin is x=2880. Chrome reports a device scale factor of 2 on this desktop, so its device-independent window coordinate is x=1440. A headed Chrome placement probe confirmed CDP bounds at x=1440 correspond to X11 window geometry at x=2880 on `HDMI-1`.

Set the persistent project-local choice in `.env.local`: use `ACTIVETAB_CHROME_DISPLAY=secondary` for HDMI-1 or `ACTIVETAB_CHROME_DISPLAY=main` for eDP-1. The tracked `.env.example` shows the setting; `.env.local` is ignored by Git. ActiveTab's CLI, MCP, API, qualification, benchmark, and test launch commands read it. A shell-provided `ACTIVETAB_CHROME_DISPLAY` overrides it, and `npm run test:on-main` / `npm run test:on-secondary` force a screen for that run. `ACTIVETAB_CHROME_WINDOW_POSITION=x,y` remains an exact-position override.

The setting applies to newly launched owned Chrome, and is reapplied when ActiveTab reuses or reattaches to a browser in an explicitly configured ActiveTab-owned profile. It does not reposition a user's browser attached through the extension or default-profile auto-connect, and it never changes display modes. Tests that explicitly request headless Chrome remain headless and have no visible window.

The defaults are `ACTIVETAB_CHROME_DISPLAY=secondary`, `ACTIVETAB_CHROME_MAIN_POSITION=0,0`, and `ACTIVETAB_CHROME_SECONDARY_POSITION=1440,0` in Chrome device-independent desktop coordinates. Override either position if the monitor arrangement or desktop scaling changes. `npm test` and `npm run test:headed` read the display setting from `.env.local`; without that file, the default remains secondary.

Examples:

```bash
npm run test:on-secondary
npm run test:on-main
ACTIVETAB_CHROME_DISPLAY=secondary npm run benchmark:response-inspection
ACTIVETAB_CHROME_DISPLAY=secondary npm run benchmark:semantic-observation
```

`launchOwnedChrome()` applies the selected position through `Browser.setWindowBounds` and verifies the resulting bounds before the app URL loads. Reuse and exact-target reattachment also apply and verify the configured position on their explicitly owned profiles. For independent verification, compare `window.screenX * window.devicePixelRatio` with the physical monitor origin; on this desktop the secondary begins at x=2880. Recheck `xrandr --query` if monitors are reconnected, rotated, or change resolution.
