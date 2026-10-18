# Fixture Lab

Fixture Lab is ActiveTab's qualification and adaptation subsystem. It lets an ActiveTab run test a navigation strategy against a reproducible fixture or independently maintained benchmark before that strategy is reused. It is part of ActiveTab's runtime capability surface, while each fixture server remains a separate target.

Qualification uses the same native CDP navigation engine as ordinary ActiveTab work. The driver receives a public task and an explicitly bound target. Provider-side oracles remain outside the driver and score the resulting application state afterward. Fixture success never proves a live staging or production result.

## Current targets

- `fi-agent-twin`: local two-origin Cloud Agent simulation with separate authentication realms, asynchronous runs, scoped diagnostics, fault injection, and a separate oracle.
- `webarena-infinity-gmail`: the standalone Gmail application from WebArena-Infinity, pinned to commit `1ca77813bf8d8e4011aa3fb1f740f70d78bd522d`. The checked-in adapter supports one bounded task: mark the seeded `Q1 Product Roadmap Review` message from Sarah Chen as read.

## Run the external application locally

WebArena-Infinity's application server uses the Python standard library. ActiveTab does not need Docker, Playwright, BrowserGym, or additional Node packages to control it.

Clone the pinned upstream checkout outside this repository, for example under `/tmp/activetab-webarena-infinity`, then enter `apps/gmail`. Apply ActiveTab's reviewed adapter patch from that directory:

```sh
python3 /home/bamn/ActiveTab/test-lab/adapters/prepareWebArenaInfinity.py
python3 server.py --port 8000
```

Set a random `ACTIVETAB_WEBARENA_ORACLE_TOKEN` of at least 32 characters in both the app server and ActiveTab process, and set `ACTIVETAB_BENCHMARK_WEBARENA_INFINITY_URL=http://127.0.0.1:8000` for ActiveTab. Keep the token out of task inputs and browser-visible page data. The patch binds the upstream server to loopback, protects verifier state and reset routes, and accepts only a small bounded seed through a separate oracle route. The provider seeds and verifies state over that route; it does not launch a setup browser. The actual benchmark driver owns the browser lifecycle and opens the app for the task. No external app state or oracle credential is retained in telemetry.

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

Completed qualifications are linked to the originating run and source events. Successful records are scoped candidate knowledge, not automatic workflow promotion, permission, or training labels.
