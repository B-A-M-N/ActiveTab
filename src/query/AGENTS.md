# Local Semantic Queries

## Purpose

Parse bounded declarative data queries and constrained control lookups against one compiled semantic-page v3 observation.

## Local Contracts

- Queries read only locally retained semantic-page evidence. They never inspect the DOM independently, call a model, or issue network requests.
- Collection queries return typed visible values only after trusted field-read and output-release callbacks both approve every source field. Page-provided classification is never authoritative.
- Query results carry the source observation, record, value evidence reference, and one of the extraction field resolution states. Collection output remains `observed_partial` because semantic-page evidence does not prove collection completeness.
- Control queries return fresh observed target references with `actionAuthorized: false`. They do not create operation grants or bypass `authorizedExecutor`.
- A semantic control query must report `incomplete` when candidate, frame, or closed-shadow coverage cannot prove absence or uniqueness. The retained observer lookup is an advisory diagnostic over the same evidence and cannot upgrade query completeness or authorize an action.
- Stale evidence, unknown fields, duplicate associations, invalid types, oversized queries, and missing policy fail closed.
- Query grammar is deliberately bounded; unsupported nested collection resolution is reported instead of approximated.

## Verification

```bash
node --test test/semantic-query.test.js
```

## Child DOX Index

No child DOX boundaries.
