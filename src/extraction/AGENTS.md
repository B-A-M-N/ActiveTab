# Structured Extraction

## Purpose

Resolve visible structured records into typed, provenance-bearing outputs with explicit completeness and release contracts.

## Ownership

ActiveTab extraction primitives. Site registration and authorization are owned by `src/capabilities/`; browser effects remain owned by the authorized executor.

## Local Contracts

- Extraction uses fresh retained DOM evidence and registered field mappings. It does not execute page code or replay observed network requests.
- Table rows include only cells whose nearest ancestor row is that row, so nested-table cells cannot shift outer columns; nested text remains part of its containing cell's text value.
- `discoverVisibleTables()` remains a metadata-only discovery projection. `discoverVisibleTableSources()` is an internal semantic-compilation view that adds observation-local DOM node locators and per-row/cell evidence; these locators are not executable capabilities.
- Table and repeated-record discovery/resolution accept an optional shared index from `src/observe/documentIndex.js`. The index must belong to the exact snapshot argument; mismatched snapshots are rejected, and callers must not cache indexes across observations.
- Values are normalized against declared scalar types. Every field retains its source header or observed tag/class-token source, exact registered route, observation ID, row, and extraction method.
- Completeness requires the declared exact record count or an explicitly authorized pagination-exhaustion contract, in addition to schema validity, required fields, uniqueness, provenance, and record/page limits.
- One-shot observed reads may release a max-record-limited prefix as `observed_partial` only when the output explicitly records `visible_record_limit_reached`, `overflow: true`, `completionPolicy: "observed_only"`, no completeness claim, and exactly the declared maximum number of rows. The same overflow remains invalid for complete extraction.
- Partial observed reads preserve duplicate visible records unless the caller supplies an explicit `uniqueBy` contract. Display fields such as a product or book name are not assumed unique; complete registered extraction still requires a valid uniqueness contract.
- Automatically synthesized card reads bind to one exact, uniquely observed repeated-record group and require its semantic-page observation/frame/document identity and ordered source key/tag list to match extraction discovery. Semantic roles and labels help resolve requested fields, but trusted field classification, read authorization, release authorization, and fresh source validation remain mandatory.
- Pagination strategies are explicitly registered and bounded: same-origin/same-path `rel=next` links, exact-label next links or native next buttons, monotonic same-path page-number query parameters, and visible-table-owned virtualized scrolling. Link and query routes are re-resolved from fresh evidence; button targets are re-resolved by frame and backend node, then clicked through the authorized executor. Every page must add unique records or change its bound cursor, and virtual scrolling must change scroll position and expose new records. Empty terminal pages, ambiguous controls, stalled progress, external or cross-path transitions, cycles, and page/record limits cannot produce complete output.
- `collectionService.js` owns the shared bounded page loop for declarative and synthesized extraction. It accumulates page provenance, detects cycles and limits, and accepts navigation only through the caller's injected authorized executor.
- A missing/ambiguous next-link result is not a completion proof when the terminal page is empty. `pagination_exhausted` requires a non-empty final page and the registered pagination strategy's explicit terminal result.
- Caller output release is evaluated after extraction. Credentials are never releasable; omitted fields make the result partial.
- CSV output neutralizes formula-leading strings. Raw values stay out of receipts and durable task journals.
- Interrupted MCP registered extraction may checkpoint already released `incomplete` output in a separate owner-only result artifact. It binds task, target, environment, principal, intent, capability, source observation, and policy fingerprints; it stores cursor and page identity fingerprints rather than raw cursor URLs, strips query strings from source routes, and cannot contain unresolved operations. Resume requires fresh scope/policy checks and a fresh observation. Virtualized scrolling and same-URL button transitions are not checkpointed because their next cursor cannot be reconstructed safely.

## Verification

```bash
node --test test/extraction.test.js test/api-output-files.test.js
```

## Child DOX Index

No child DOX boundaries.
