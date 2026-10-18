# Structured Extraction

## Purpose

Resolve visible structured records into typed, provenance-bearing outputs with explicit completeness and release contracts.

## Ownership

ActiveTab extraction primitives. Site registration and authorization are owned by `src/capabilities/`; browser effects remain owned by the authorized executor.

## Local Contracts

- Extraction uses fresh retained DOM evidence and registered field mappings. It does not execute page code or replay observed network requests.
- Values are normalized against declared scalar types. Every field retains its source header or observed tag/class-token source, exact registered route, observation ID, row, and extraction method.
- Completeness requires the declared exact record count or an explicitly authorized pagination-exhaustion contract, in addition to schema validity, required fields, uniqueness, provenance, and record/page limits.
- Pagination candidates are visible native links with `rel=next`, same origin, and exact registered path. Ambiguous, external, cyclic, or unverified transitions cannot produce complete output.
- Caller output release is evaluated after extraction. Credentials are never releasable; omitted fields make the result partial.
- CSV output neutralizes formula-leading strings. Raw values stay out of receipts and durable task journals.

## Verification

```bash
node --test test/extraction.test.js test/api-output-files.test.js
```

## Child DOX Index

No child DOX boundaries.
