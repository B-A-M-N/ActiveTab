# FreeInference staging discovery

## Purpose

Keep the Cloud Agent application workflow and its Admin dashboard as separate
recipes. The browser primitives are reusable; a recipe chooses only the
surfaces and controls relevant to the current debugging question.

## Recipes

- staging-dashboard-inventory reads the authenticated main staging account
  Dashboard's visible model catalog and records its exact Agents and Settings
  links. It does not click controls or read account field values.
- admin-dashboard-inventory visits the Cloud Agent application's profile-declared Audit, Activity,
  Measurements, Usage, Database, and visible Settings pages.
- admin-settings-review inspects only the visible Settings page.
- admin-activity-review visits Activity, Measurements, and Usage.
- admin-audit-review visits Audit and samples one reversible row disclosure
  for each visible audit category.

The Admin recipe is an independent entrypoint. It does not create a Cloud
Agent task, run a PR test, or change settings. Cloud Agent task execution and
its task/history investigation remain separate work.

The account Admin Console at `staging.freeinference.org/dashboard/admin/...`
is a separate application surface from the Cloud Agent Admin pages at
`agents-staging.freeinference.org/admin/...`. In particular, the Cloud Agent
Admin **Audit** category walkthrough described below is distinct from the
account Admin Console **Audit Log**. The operator prohibited opening or
interacting with the account Audit Log; its route, purpose, and dropdown
choices remain unknown. The account Audit Log navigation is blocked by the
ActiveTab restriction at the browser navigation and control boundaries.

## Main staging account Dashboard

The authenticated account Dashboard is
`https://staging.freeinference.org/dashboard`. Its Models section is below the
fold and appears before the Agents and Admin Console links. Following the
visible Agents link opens the separate Cloud Agent application at
`https://agents-staging.freeinference.org/`; that application has a separate
login/session realm.

The main Dashboard's **Admin Console** link points to
`/dashboard/admin/users`. This is a privileged account-level surface and is
separate from the Cloud Agent application's own Admin area under
`agents-staging.freeinference.org/admin/`. The account Dashboard recipe
records the visible destination only. A separate operator-directed
walkthrough can inspect information there; changing settings requires the
FreeInference authorization the user specified.

The operator opened `/dashboard/admin/users` for this walkthrough. The page
showed an Admin heading, a user search field, status/provider/quota filters,
spend and activity thresholds, a rows-per-page selector, and a table with
columns `SPEND (USD)`, `USAGE · ALL-TIME`, `BEHAVIOR`, `USER`, `STATUS`,
`TODAY`, `7d`, `MONTH`, `ALL-TIME`, `REQUESTS`, `TOKENS`, `AVG TURNS`,
`AVG USER TURNS`, `ASK-QUESTION`, and `SCORE`. Filter choices included
`All statuses`, Pending/Active/Suspended/Rejected/Deleted; `Any provider`, Chutes, DeepSeek,
Featherless, Kimi (coding plan), MiniMax, Ollama, OpenRouter, the retired
`router` provider, SGLang, Tencent Token Plan, vLLM, and ZAI; quota categories
Any, Default, Custom, Near quota (≥80%), and Over quota; thresholds `Today ≥ $`,
`Month ≥ $`, and `Active in last (h)`; and 50/100/250/500 rows per page. No
filter was changed and no user row, email, key, or account value was retained
in the inventory. The page also exposes the `Pending`, `Top spenders today`,
`Anomalies`, `Near quota`, and `Recently active` views. Spend cards and the
spend, request, and token columns are relevant incident signals. Routine
inventory records their labels and structure only; an incident workflow may
retrieve user-level spend only for an explicitly identified account and time
window.

The operator reports a `Clear Last Hours` button under Admin Console / Recent
Requests and has designated it permanently off limits. ActiveTab must not click
or submit it under any goal. This is recorded as an operator-reported hard deny;
the control's exact effect has not been independently verified, and no attempt
to invoke it was made.

The operator reports that Recent Requests can export JSONL for different time
periods and supports additional filters through text-entry fields and dropdown
menus. This is a high-value incident diagnostic source. The available filter
labels, placeholders, dropdown choices, and time-period choices still need a
read-only inventory on an operator-opened route. Do not type a filter, change a
selection, or initiate a download during discovery. Treat an export as
request-level sensitive and require an explicit incident scope (account or run
plus time window) and FreeInference authorization first.

The operator reports that Admin Console → Overview → Providers has Overview
and Performance subtabs. Performance contains multiple dropdown menus and a
filter text field. The route and available choices have not yet been
live-inventoried; when the operator opens those views, record labels and
choices without typing or changing selections. `Manage`, `Edit`, `Add`, and
`Delete Keys` are hard-denied within the Providers surface and must never be
clicked or submitted.

The operator mentioned Log and Audit Log under Admin Console. A screenshot
confirms that `Log` is a tab label, but its purpose and route remain unknown.
Its relationship to Audit Log is unconfirmed. Audit Log is explicitly off
limits, including its dropdowns; do not open the view or inspect its options.
No Log or Audit Log data has been inventoried.

Admin Console Settings and Config need a read-only inventory so their current
configuration is understood. Record visible control labels and non-sensitive
current values, redact secrets, and do not operate controls or change values
without explicit FreeInference authorization. A screenshot has partially
inventoried the Settings page; the Configuration page and content below the
visible Settings viewport remain unknown. The recipe only runs after the
operator opens a profile-declared Settings or Configuration route in the
authorized tab; it reads visible headings and control state/value metadata,
submits no forms, and writes a private local report. Run it with
`npm run discover:staging-admin-config`.

### Account Admin Console Settings

An operator-provided screenshot dated 2026-10-17 shows
`/dashboard/admin/settings`, with Settings selected and a Configuration tab
visible. The page heading is Admin. The visible Feature Flags section says
runtime features can be toggled without restarting the server and that
changes take effect immediately. Three visible switches are displayed on:

- User Auth Enabled — requires user API keys for inference requests; account
  login remains enabled.
- Signup Enabled — allows new user signups.
- Signup Require Email Verification — requires email verification for new
  signups. This row is partly below the screenshot viewport.

No switch was operated. The screenshot does not establish the current live
state or reveal content below the viewport. Configuration was not opened, and
its route and contents remain unknown. The Log tab is visible in the same
navigation, but was not opened. This screenshot record is read-only evidence,
not authorization to change any setting.

Live read-only observation on 2026-10-17 found 42 model labels in the account
Dashboard's Models section:

```text
glm-5.1, glm-5.2, glm-5.3, glm-5.3-flash, glm-5-turbo,
minimax-m2.5, minimax-m3, minimax-fast, kimi-k2.7-code,
kimi-k2.7-code-highspeed, kimi-k3, qwen3.6-35b, diffusiongemma,
deepseek-v4-flash, deepseek-v4.1-flash, llama-3.1-8b, ministral-3-8b,
llama-3.3-70b, llama-3.1-70b, morena-1.5b-instruct, llama-bimultisd,
gpt-oss-20b, gemma-4-31b, gemma-sea-lion-v4-4b-vl, gemma-3-4b,
gemma-3-12b, qwen3-8b, indictrans2-en-indic-1b, qwen3.8-27b, allam-7b,
apertus-v1.5-8b, alia-40b-instruct, llama-3.1-70b-latamgpt,
shisa-v2.1-llama3.3-70b, sarvam-105b, minimax-fast2, bge-m3,
qwen3-embedding-8b, kalm-embedding-gemma3-12b, sfr-embedding-mistral,
octen-embedding-8b, linq-embed-mistral
```

The Cloud Agent task composer has its own searchable Model dropdown. A
separate read-only observation found 36 choices. Its visible list contained
the first 36 labels above and omitted the six embedding entries: `bge-m3`,
`qwen3-embedding-8b`, `kalm-embedding-gemma3-12b`, `sfr-embedding-mistral`,
`octen-embedding-8b`, and `linq-embed-mistral`. These are independent UI
observations; they do not establish backend availability or allow one list to
stand in for the other. Re-inventory before relying on either list for a run.

Run a fresh account Dashboard inventory while the exact authorized browser
tab is on `/dashboard`:

    npm run discover:staging-dashboard

The owner-only report records visible model labels, page headings, and exact
visible Agents, Settings, and Admin Console link destinations. The Admin
Console is explicitly marked "not opened." The recipe does not click links,
expand controls, inspect API responses, or change settings.

For a separately operator-opened account Admin Console page, run:

    npm run discover:staging-admin-console

That report excludes all user rows and field values. It records only headings,
non-row control schemas, select choices, and table column labels. It does not
navigate to the page, change filters, or submit any action.

## Reusable primitives

The implementation is in src/testing/adminDashboardDiscovery.js.

- verify the exact attached tab's observed origin
- follow a visible, exact, profile-approved Admin link
- inspect headings, control labels, native select options, selected options,
  checkbox/switch state, table column labels, and row counts
- record same-origin Admin GET route shapes without query strings or bodies
- inspect one visible table-row disclosure and restore its original collapsed
  state after re-observing it
- restore the exact route observed at the start

The report omits table cell contents and free-text field values. It never reads
response bodies, submits forms, selects database tables, or changes settings.
Only routes and controls declared by the profile are eligible for interaction.
Settings is discovered from a visible same-origin Admin link; the path is not
guessed.

## Existing UI inventory

This list records the prior manual dashboard walkthrough. It is a working
inventory, not a claim that the current browser has been rescanned.

### Audit

Visible category controls: All, Settings, Servers, Measurements, Content
views, and Database. Opening a row exposes its detail panel. The automated
recipe checks one row disclosure per category and verifies that it is closed
again.

### Activity

Top-level views: Sandboxes, Sessions, Turns, and Steps. The Turn view includes
created-time and result filters. Previously observed result choices include
All results, queued, running, succeeded, failed, and cancelled. Time choices
include Last 7 days, Last 30 days, and Last 90 days.

### Measurements

The page has Measurements, Operations, Timings, and Samples areas. Operations
has All Operations, Sandbox Startup, Terminal Opening, File Listing, and File
Opening choices. Timings has a server selector. Operations and Timings are
expandable UI sections; the recipe opens only an explicit disclosure and
restores it.

### Usage

Time-range choices observed: Last 7 days, Last 30 days, and Last 90 days.

### Database

Visible table names observed: agent_audit, agent_jobs, agent_attempts,
agent_sandboxes, agent_threads, and agent_tool_resources. The page exposes Add
filter, Sort by, Sort direction, and Rows per page controls. Observed sort
directions are Ascending and Descending; page sizes are 25, 50, 100, and 200.
The discovery recipe records these control schemas but does not select a
table, add a filter, or read table rows.

### Settings

The Settings surface and its controls still need a live inventory. The
Cloud Agent Admin profile only permits following an exact visible Settings
link under that application's Admin path. This is separate from the account
Admin Console Settings/Config inventory above. The Cloud Agent Admin recipe
records native select choices and current checkbox/switch states, but never
stores text-field values. It does not click save, apply, reset, or
enable/disable controls.

## Previously observed diagnostic route shapes

The following endpoint paths appeared in earlier UI network observations.
They are retained as leads for future profile validation; this document does
not assert that every route is a harmless GET or that its response is safe to
export:

- /api/admin/agent/audit-log
- /api/admin/agent/conversations
- /api/admin/agent/profiling-control
- /api/admin/agent/measurement-writer
- /api/admin/agent/profiling-runs
- /api/admin/agent/profiling-runs/:id/summary
- /api/admin/agent/measurements
- /api/admin/agent/usage
- /api/admin/agent/database/tables
- /api/admin/agent/database-tools

The discovery report records only observed GET method, path, status, content
type, and count for the profile's Admin API prefix. It omits query strings,
request bodies, response bodies, and record values.

## Running a recipe

First attach the exact authenticated Cloud Agent tab using ActiveTab's
per-tab Attach action. Keep the tab on the Cloud Agent app or its Admin area,
then set ACTIVETAB_AUTHORIZED_TARGET_ID to that attached tab's exact target
identifier.

Run the complete dashboard inventory:

    npm run discover:staging-admin

Run only the still-pending Settings inventory:

    npm run discover:staging-admin:settings

Or choose areas directly, for example:

    node scripts/discover-staging-admin.mjs --area=audit,activity

For the separately operator-opened account Admin Console Settings or
Configuration page, run:

    npm run discover:staging-admin-config

This command does not navigate. It requires the exact attached tab to already
be on a profile-declared Settings or Configuration route under
`/dashboard/admin/`; it reads visible control labels and non-sensitive current
values only. Audit Log routes are refused.

Reports are written under .activetab/qualification/admin-discovery with
owner-only directory and file permissions. Discovery closes only its CDP
attachment; it leaves the operator's browser process and tab open.

## Current limitation

The profile includes a partial Settings inventory from the operator-provided
screenshot. A fresh live inventory is still needed to confirm current values,
inspect content below the viewport, and inspect Configuration. A read-only
live run requires the authenticated tab to be explicitly attached to this
ActiveTab runtime and the operator to open the exact Settings or Configuration
page first.
