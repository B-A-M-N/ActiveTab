# ActiveTab HTTP API

## Purpose

Owns local HTTP composition and endpoint-family adapters.

## Ownership

`local-server.js` owns server construction, host/origin checks, request diagnostics, shared dependencies, and route ordering. Route modules handle one endpoint family using dependencies injected by that composition layer.

## Local Contracts

- Route handlers do not create alternate browser execution or policy paths. Browser effects use the existing application run service or authorized executor.
- Authentication and operator identity come from server-owned authenticators. Request bodies contain caller input only and cannot select trusted identity, knowledge storage, or grant configuration.
- Durable run-state and target lease operations use the configured stores and existing coordinators.
- Route extraction preserves method/path matching, status codes, response bodies, authentication order, redaction, and error behavior.
- The discovery routes use server-composed environment, principal, and canonical knowledge directory. Discovery holds the current target lease for its run.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `routes/` | Endpoint-family handlers with injected server-owned dependencies |
| `routes/capabilities.js` | Capability discovery, read, compile, qualification, listing, and revocation endpoints after shared API authentication |
| `routes/interventions.js` | Intervention status, acknowledgement, approval, resume, cancellation, and run-state endpoints with server-owned authentication and tools |
