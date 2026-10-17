# FreeInference Staging Qualification Reference

Application-specific reference for qualifying ActiveTab against the FreeInference staging environment and Cloud Agent application. This file contains no credentials, tokens, or session material.

## Environment Identity

- **Environment ID:** `freeinference-staging`
- **Application entry URL:** `https://staging.freeinference.org`
- **Authorized origins:** `https://staging.freeinference.org` (additional origins only if explicitly authorized in the profile)
- **Diagnostic transport:** SSH tunnel to a verified remote target, or direct HTTPS with an explicitly configured admin endpoint.
- **Diagnostic endpoint:** loopback is permitted only with `ACTIVETAB_CLOUD_AGENT_TRANSPORT=ssh_tunnel` and `ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET` set to the verified remote staging target.

## Agents Application Realm

The Agents application is the first Cloud Agent qualification target. Its authentication realm is the browser's authenticated Agents session. ActiveTab must verify:

1. The browser URL is on `https://staging.freeinference.org`.
2. The Agents application is loaded and an authenticated session is present.
3. The environment binding matches the profile.

Authentication verification must be non-sensitive: an authenticated identity source in the correct realm, not credential export.

## Test-Owned Operations

Qualification uses exactly one safe, test-owned operation. The recommended operation is:

1. **Create** a uniquely identified Cloud Agent resource (e.g. a connector) with a test-owned naming prefix and durable identity in the operation ledger.
2. **Execute** a harmless, deterministic test action through the actual Agents application UI.
3. **Verify** the expected application result using an independent oracle.
4. **Correlate** the browser operation with a backend run or operation identifier.
5. **Clean up** the exact test-owned resource and verify its absence or terminal deletion state.

No existing user resources may be created, modified, or deleted. No broad wildcard deletion. No cross-tenant access.

## Human Handoffs

The following states require human interaction and must suspend for durable intervention:

- Login or MFA challenge → `WAITING_FOR_AUTHENTICATION` / `WAITING_FOR_MFA`.
- Anti-automation detection → `WAITING_FOR_HUMAN_DECISION` (challenge bypass is out of scope).
- Destructive or shared-resource mutation → `WAITING_FOR_HUMAN_APPROVAL` with a scoped grant.
- Tab authorization required in attached mode → `WAITING_FOR_TAB_AUTHORIZATION`.

## Authorized Diagnostic Access

The Cloud Agent diagnostic adapter provides backend evidence. Supported evidence categories:

| Evidence                        | Use                                                |
| ------------------------------- | -------------------------------------------------- |
| Test operation/run identity     | Exact browser-to-backend correlation               |
| Worker execution state          | Scheduling, execution, and recovery bugs           |
| Step/event history              | Identify where execution diverged                  |
| Retry and cancellation records  | Distinguish resumed, duplicated, abandoned work    |
| Model usage and cache telemetry | Performance and cost attribution                   |
| Sandbox lifecycle               | Startup, failure, cleanup, orphan investigation    |
| Relevant audit events           | Administrative effect attribution                  |
| Configuration metadata          | Detect non-secret environment differences          |

The actual deployed API surface must be checked against these categories. The adapter must not assume endpoints exist.

## Independent Oracles

Verification must use an independent oracle — not merely a changed DOM or HTTP 200. Acceptable oracles include:

- Backend record matching the test's exact run/resource identity.
- Expected state in a scoped diagnostic response.
- Absence of the test resource after cleanup (verified via a scoped read).

UI state changes, temporal correlation, and successful HTTP responses alone are insufficient.

## Expected Qualification Receipt

A successful FI staging qualification produces:

```
qualification:
  environment_identity: verified
  browser_authorization: verified
  application_identity: verified
  operation_execution: verified
  independent_oracle: verified
  backend_correlation: exact
  cleanup: verified
  safety_regressions: passed
  final_state: PASSED
```

Partial or blocked results must label unverified fields honestly.
