# Desktop Test Display Map

Observed on 2026-10-19 with `xrandr --query` on `DISPLAY=:1`:

| Role | Output | Resolution | Desktop position | Primary |
|---|---|---:|---:|---|
| Main screen | `eDP-1` | 2880×1620 | `0,0` | Yes |
| Secondary screen | `HDMI-1` | 2560×1440 | `2880,0` | No |

The `HDMI-1` output is the requested screen for current headed browser testing. The physical HDMI-1 origin is x=2880. Chrome reports a device scale factor of 2 on this desktop, so its device-independent window coordinate is x=1440. Set `ACTIVETAB_CHROME_DISPLAY=secondary` to select HDMI-1, or `ACTIVETAB_CHROME_DISPLAY=main` to select eDP-1. The same setting applies to every newly launched ActiveTab Chrome process, including owned-browser runs, direct CDP integration tests, extension tests, and the API runner. It does not move existing windows or change display modes. Tests that explicitly request headless Chrome remain headless and have no visible window.

The defaults are `ACTIVETAB_CHROME_MAIN_POSITION=0,0` and `ACTIVETAB_CHROME_SECONDARY_POSITION=1440,0` in Chrome device-independent desktop coordinates. Override either position if the monitor arrangement or desktop scaling changes. `ACTIVETAB_CHROME_WINDOW_POSITION=x,y` can set an exact position and takes precedence over the named display.

Examples:

```bash
npm run test:on-secondary
npm run test:on-main
ACTIVETAB_CHROME_DISPLAY=secondary npm run benchmark:response-inspection
ACTIVETAB_CHROME_DISPLAY=secondary npm run benchmark:semantic-observation
```

`launchOwnedChrome()` applies the selected position through `Browser.setWindowBounds` and verifies the resulting bounds before the app URL loads. For independent verification, compare `window.screenX * window.devicePixelRatio` with the physical monitor origin; on this desktop the secondary begins at x=2880. Recheck `xrandr --query` if monitors are reconnected, rotated, or change resolution. The sandbox could not open the X display directly; the mapping above was obtained with host access.
