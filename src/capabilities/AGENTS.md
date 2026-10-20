# Site Capability Contracts

## Purpose

Own discovery, compilation, qualification, persistence, and invocation of reusable application capabilities.

## Ownership

ActiveTab's capability layer. It defines typed read-only site recipes and delegates browser observation to the existing session and execution contracts.

## Local Contracts

- Discovery returns bounded structural metadata for visible HTML tables and repeated visible record groups from fresh retained evidence; it does not return records or authorize an action. For one-shot reads, the exact index used for discovery is carried into record resolution when the same immutable evidence is still current, avoiding a second structural parse.
- Table, repeated-record, and pagination discovery for one retained DOMSnapshot share one transient structural index; the metadata projection remains unchanged and the index is never reused for another observation.
- One-shot `read_page_records` and `/v3/capabilities/read` requests may resolve visible rows without compiling, qualifying, or registering a reusable recipe. They require a verified principal, trusted field classification, read permission, and release permission; profile-bound fields use the exact application policy. An unfamiliar public field may use a separate, exact run-local operator approval after conservative public classification; it binds origin, path, target, source fingerprint, exact fields, principal, record/byte limits, and expiry, then issues one single-use grant. Static denials and unclassified/personal/credential fields cannot be overridden. CLI approval is interactive; HTTP approval uses the authenticated operator channel; MCP requests wait for approval through the authenticated loopback API. Every result is `observed_partial` because page-level collection completeness is not established.
- `runLocalPublicReadGrants.js` owns one-shot grant issue, field-effect hashing, exact binding verification, expiry cleanup, and result consumption. `CapabilityService` retains discovery and observation binding; it cannot turn grant approval into a reusable recipe or a completeness claim. The service keeps its existing `publicReadGrantStore` and `publicReadGrantBindings` references as compatibility aliases.
- Ephemeral partial reads do not infer `uniqueBy` from the first requested field, since visible titles and names may legitimately repeat. They preserve duplicate visible rows unless a caller supplies an explicit uniqueness key. Reusable complete recipes still require a trusted uniqueness contract.
- Ordinary read goals may receive an ephemeral repeated-card extraction capability only when schema-v3 semantic evidence matches one unique source by observation, frame, document index, visible count, exact bounded source-group identity, and ordered source-key/tag bindings. Requested terms such as `titles` may map to a supported semantic role such as `name`; selected fields retain caller order, then undergo independent trusted classification and read/release authorization. Ambiguous mappings and denied fields abstain; model output cannot create field mappings or policy.
- A composite read goal may receive a run-local deferred extraction capability when its requested fields map to supported semantic roles. The capability resolves one unique table or record group against the fresh observation at the extraction step, checks the exact caller-requested output schema and trusted field policy, and returns only `observed_partial`. It cannot invent a field, authorize a browser operation, or reuse stale discovery evidence.
- Current-page one-shot read capabilities carry a trusted internal `executionOrigin: ephemeral_observed_read` marker that is omitted from model projections. The navigation planner may use it to build a deterministic local step only when the typed atomic intent requires exactly that capability; the marker conveys provenance, not permission, and the normal field policy, freshness checks, and output verification still apply.
- One-shot table output uses a canonical semantic field key when the observed header has exactly one supported role (for example, `Product name` becomes `name`), while preserving the exact header as the source-policy and provenance binding. If multiple requested headers collapse to the same semantic key, the source is ambiguous and no read capability is offered.
- A discovery candidate ID may be used by a later one-shot read only on its original target, principal, environment, document generation, query-aware route fingerprint, and source structure. The exact route fingerprint is derived locally from retained URL evidence with a process-private key; raw query values are never returned in candidate metadata, model projections, or receipts.
- Ephemeral extraction contracts may carry `scopeKind: "ephemeral_observed_read"` and null environment/application IDs only for unprofiled public reads. Site-capability manifest validation rejects this scope so it cannot be persisted or qualified as a reusable recipe.
- The `network/` child also discovers completed, same-origin GET JSON responses already fetched by the page. It returns schema metadata only; it does not replay, paginate, execute, or authorize API requests.
- Repeated-group recipes bind to observed container/item tag names and exact class tokens. Field extraction binds to observed source tag/class-token pairs; callers cannot supply CSS selectors or page scripts.
- Compilation receives field sensitivity and read policy only from trusted application composition, and binds each manifest to exact origin, route, environment, application, and verified principal.
- Candidate compilation and fixture qualification reobserve the same authorized target and require the same exact route, resolved application identity, and unique structured source before registering a manifest; scope is checked again after qualification completes.
- A capability is executable only after the owner-only registry accepts its qualified manifest. Resolver-only synthetic DOM checks are recorded as `resolver` and explicitly cannot claim an independent application outcome; they never qualify an application or live target.
- Qualification promotes a manifest into the same scoped registry used for retrieval. The authenticated local API can revoke only an exact capability version and full origin/environment/application/principal scope; the registry persists an owner-private tombstone, hides the revoked manifest, and refuses same-version re-registration. A later version requires fresh qualification.
- Each invocation resolves the exact registered scope and rechecks fresh route, application identity, source structure, field-release policy, and observed evidence. A source mismatch returns incomplete/blocked evidence and never falls back to a stale mapping.
- Every qualified manifest records its level, provider identity, scenario seed, source revision, oracle reference, cleanup result, and whether an independent application outcome was checked. Visible extraction manifests currently accept resolver-level qualification only. `outcome` and `live` claims belong in separate benchmark receipts; `live` also requires a scoped authorization reference.
- Recipes name registered operations only. They cannot contain JavaScript, arbitrary endpoints, credentials, or caller-authored authority.
- Pagination requires a trusted exact-scope policy, a visible same-origin same-path `rel=next` link, bounded page count, and dispatch through the shared authorized browser executor.
- Registry manifests and policy files are bounded owner-private files. Unqualified or scope-mismatched manifests fail closed.
- The in-process extraction qualifier is a resolver regression baseline; it does not substitute for independently maintained applications such as WebArena-Infinity.

## Verification

```bash
node --test test/extraction.test.js test/capability-api.test.js
```

## Child DOX Index

| Path | Purpose |
|------|---------|
| `runLocalPublicReadGrants.js` | Exact-scope one-shot public-read grant issue, verification, expiry, and consumption |
| `network/` | Read-only observed API response discovery and independent shape qualification |
