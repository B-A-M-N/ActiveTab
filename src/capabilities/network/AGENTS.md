# Observed API Capability Discovery

## Purpose

Discover same-origin, read-only JSON API shapes from browser responses that the application already fetched. This subsystem does not replay requests or define authority for application mutations.

## Local Contracts

- Discovery consumes one fresh observation and its retained network-activity facet. It accepts only completed successful GET Fetch/XHR JSON responses on the exact page origin, without URL query strings or redirects.
- Response bodies are inspected only for the caller-selected request ID through the existing observer. Response values are always redacted by the observer; candidates retain field paths, scalar types, credential-shape metadata, and counts, never record values.
- Credential-like fields are not eligible for reads. Every other field still requires trusted field classification before extraction or release.
- A candidate is bound to exact origin, page route, API route, environment, application, principal, observation, document generation, and request identity.
- Qualification requires independent fixture oracles and must check schema, completeness, and privacy boundaries across every bounded variant.
- The local API exposes network discovery, selected-response inspection, and qualification routes. No generic API fixture oracle is installed by default, so qualification reports unavailable until trusted composition supplies one.
- API discovery does not execute, replay, paginate, or authorize requests. API operations and pagination require a separately reviewed execution contract.
- `networkApiCapabilityService.js` owns the bounded, expiring candidate map and discovery → selected inspection → independent fixture qualification lifecycle. `CapabilityService` retains its public method delegates; the service creates no operation grants or request execution path.

## Verification

`node --test test/api-capability-discovery.test.js test/capability-api.test.js`

## Child DOX Index

| Path | Purpose |
|------|---------|
| `networkApiCapabilityService.js` | Bounded scoped candidate lifecycle and qualification orchestration |
