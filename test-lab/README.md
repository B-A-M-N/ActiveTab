# Fixture Lab

Fixture Lab is ActiveTab's qualification and adaptation subsystem. It lets an ActiveTab run test a navigation strategy against a reproducible fixture or independently maintained benchmark before that strategy is reused. It is part of ActiveTab's runtime capability surface, while each fixture server remains a separate target.

The native CDP integration suite also exercises a local API-shape fixture. The browser discovers only a same-origin JSON GET already made by the page, then explicitly selects the retained response for schema inspection. Qualification uses the provider-side `api-shape-twin` oracle across 30 seeded record sets; the oracle contract and fixture records stay outside browser evidence. This qualifies response shape only and does not authorize API execution, replay, or registration.

Qualification uses the same native CDP navigation engine as ordinary ActiveTab work. The driver receives a public task and an explicitly bound target. Provider-side oracles remain outside the driver and score the resulting application state afterward. Fixture success never proves a live staging or production result.

Public live-site qualification is a separate ActiveTab path, not a Fixture Lab scenario. List reviewed scenarios with `npm run qualify:public-sites -- --list`; run the real search-and-browse scenario with `npm run qualify:public-sites -- --scenario-id public-search-wikipedia-001 --confirm-readonly --allow-jev-visual`. It opens headed Chrome at a trusted DuckDuckGo GET URL for a generated query, uses NavigationEngine's automatic route to send the observed result selection to the configured secondary model, optionally sends a bound screenshot to Jev when image capability and consent are available, and independently checks the final page against a direct HTTP read. Owner-only inference history and receipts persist after the temporary browser profile is deleted.

## Current targets

- `fi-agent-twin`: local two-origin Cloud Agent simulation with separate authentication realms, asynchronous runs, scoped diagnostics, fault injection, and a separate oracle.
- `webarena-infinity-gmail`: the standalone Gmail application from WebArena-Infinity, pinned to commit `1ca77813bf8d8e4011aa3fb1f740f70d78bd522d`. The adapter supports marking a seeded message as read and extracting a bounded synthetic inbox through ActiveTab's qualified visible-record capability. The independent oracle checks exact extracted values and cleanup.

The in-process seeded resolver remains a fast baseline. WebArena-Infinity is an independent application target: its Gmail extraction task launches a dedicated Chromium profile, observes the real rendered UI, discovers and qualifies a visible-record recipe, runs collection through ActiveTab's declarative runner, and scores the result against an isolated oracle. This is one pinned extraction task, not broad benchmark coverage.

## Run the external application locally

WebArena-Infinity's application server uses the Python standard library. ActiveTab does not need Docker, Playwright, BrowserGym, or additional Node packages to control it.

Use a disposable copy of the pinned upstream checkout outside this repository, for example `/tmp/activetab-webarena-infinity-qualification-copy`; keep any existing checkout with local changes untouched. From its `apps/gmail` directory, apply ActiveTab's reviewed server and UI seed adapters:

```sh
python3 /home/bamn/ActiveTab/test-lab/adapters/prepareWebArenaInfinity.py
python3 /home/bamn/ActiveTab/test-lab/adapters/prepareWebArenaInfinitySyntheticUiSeed.py
python3 server.py --port 8000
```

Set a random `ACTIVETAB_WEBARENA_ORACLE_TOKEN` of at least 32 characters in both the app server and ActiveTab process, and set `ACTIVETAB_BENCHMARK_WEBARENA_INFINITY_URL=http://127.0.0.1:8000` for ActiveTab. Keep the token out of task inputs and browser-visible page data. The server patch binds the upstream app to loopback, protects verifier state and reset routes, and accepts only a small bounded seed through a separate oracle route. The UI patch serves only the synthetic seeded email fields to the page before app initialization. The provider seeds and verifies state through the isolated route; the driver owns a dedicated browser profile and runs the actual extraction workflow. No external app state or oracle credential is retained in telemetry.

The service is available to declarative test workflows through a `qualify` step. Set `required: true` only when fixture qualification itself is a workflow requirement. By default, unavailable qualification is recorded as advisory so the parent automation flow can continue.

Example step:

```json
{
  "id": "qualify_navigation_strategy",
  "type": "qualify",
  "scenarioId": "webarena-infinity-gmail-task-001",
  "providerId": "webarena_infinity_gmail",
  "trigger": "ambiguous_target",
  "required": false
}
```

The extraction scenario is `webarena-infinity-gmail-extract-001`. It seeds only synthetic subjects and sender names. When ActiveTab runs this qualification operation, it uses a dedicated browser profile and returns only the schema-validated synthetic records; the oracle state and token are never passed to the browser driver.

Completed qualifications are linked to the originating run and source events. Successful records are scoped candidate knowledge, not automatic workflow promotion, permission, or training labels.
