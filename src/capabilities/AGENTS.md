# Site Capability Contracts

## Purpose

Own discovery, compilation, qualification, persistence, and invocation of reusable application capabilities.

## Ownership

ActiveTab's capability layer. It defines typed read-only site recipes and delegates browser observation to the existing session and execution contracts.

## Local Contracts

- Discovery returns bounded structural metadata from fresh retained evidence; it does not return records or authorize an action.
- Compilation receives field sensitivity and read policy only from trusted application composition, and binds each manifest to exact origin, route, environment, application, and verified principal.
- A capability is executable only after a configured Fixture Lab qualifier returns independently scored evidence and the owner-only registry accepts the manifest.
- Recipes name registered operations only. They cannot contain JavaScript, arbitrary endpoints, credentials, or caller-authored authority.
- Pagination requires a trusted exact-scope policy, a visible same-origin same-path `rel=next` link, bounded page count, and dispatch through the shared authorized browser executor.
- Registry manifests and policy files are bounded owner-private files. Unqualified or scope-mismatched manifests fail closed.
- The in-process extraction qualifier is a resolver regression baseline; it does not substitute for independently maintained applications such as WebArena-Infinity.

## Verification

```bash
node --test test/extraction.test.js test/capability-api.test.js
```

## Child DOX Index

No child DOX boundaries.
