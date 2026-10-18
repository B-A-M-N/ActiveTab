# Reusable Site Capabilities and Structured Extraction

ActiveTab has an end-to-end first slice for discovering visible HTML tables and repeated visible DOM record groups, compiling a trusted typed field contract, qualifying a candidate, storing a scoped recipe, collecting across bounded pagination, validating the result, and returning JSON/CSV-compatible output through the existing task API.

Repeated record groups are discovered from observed container/item tag names and exact class tokens. Their fields bind to observed tag/class-token pairs. This supports common card and list markup without accepting caller-provided selectors or arbitrary page scripts.

The extractor does not yet support virtualized lists or application APIs. Those require separately qualified registered adapters; the model or caller cannot supply executable code or an endpoint.

## Configure trusted field policy

The local API reads `ACTIVETAB_EXTRACTION_POLICY_FILE` at startup. The file must be a regular owner-private file with mode `0600` or stricter, no larger than 256 KiB, and schema version `1`.

```json
{
  "version": 1,
  "entries": [
    {
      "environmentId": "staging",
      "applicationId": "catalog",
      "origin": "https://catalog.example",
      "sourceHeader": "Product name",
      "dataClass": "public",
      "allowRead": true,
      "allowRelease": true
    },
    {
      "environmentId": "webarena-infinity-local",
      "applicationId": "webarena-infinity-gmail",
      "origin": "http://127.0.0.1:8000",
      "sourceKey": "email-sender",
      "dataClass": "public",
      "allowRead": true,
      "allowRelease": true
    },
    {
      "environmentId": "webarena-infinity-local",
      "applicationId": "webarena-infinity-gmail",
      "origin": "http://127.0.0.1:8000",
      "sourceKey": "email-subject-text",
      "dataClass": "public",
      "allowRead": true,
      "allowRelease": true
    }
  ],
  "pagination": [
    {
      "environmentId": "staging",
      "applicationId": "catalog",
      "origin": "https://catalog.example",
      "pagePath": "/products",
      "kind": "rel_next_same_path",
      "maxPages": 10
    }
  ]
}
```

Classification and release match the exact environment, application, origin, and either a source header or an observed source key. Credentials cannot be read or released through this subsystem. Without explicit trusted classification and read policy, no fields are eligible.

`ACTIVETAB_CAPABILITY_DIR` selects the owner-private capability registry; the default is `.activetab/capabilities`. Browser execution also requires an explicit authorized session and environment profile. The API automation token does not create those bindings.

## Workflow

1. `POST /v3/capabilities/discover` returns visible table headers or repeated-group tag/class structure, row counts, route, and short-lived candidate IDs. It does not return record values.
2. `POST /v3/capabilities/compile` supplies a capability ID, typed fields, exact-count or pagination completion policy, uniqueness keys, and bounded row/page limits. Sensitivity comes from the trusted policy file.
3. `POST /v3/capabilities/recipes/{recipeId}/qualify` runs deterministic seeded structural and negative variants. Callers cannot supply qualification evidence.
4. `GET /v3/capabilities` lists registered qualified recipes and their typed output contracts.
5. Run `local-page-data-extractor` with the registered capability ID and exact registered origin/path. ActiveTab reobserves the page, resolves fresh DOM evidence, navigates only approved pagination links through the authorized executor, validates the output, applies field release policy, and returns records with provenance and completeness status.

The compiler supports two count contracts:

- `exact_count`: requires `expected_records`; the result must match that count.
- `pagination_exhausted`: requires explicit pagination authorization and a minimum count. It completes only after the registered pagination strategy reaches its terminal condition within the page limit.

Every record is checked for declared fields, scalar types, required values, uniqueness keys, and per-field observation provenance. Missing tables, layout drift, duplicate keys, field denial, pagination ambiguity/cycles, limits, or failed navigation cannot produce a complete output. CSV strings that begin with spreadsheet formula characters are escaped.

## Qualification limits

The built-in extraction qualifier exercises the resolver against deterministic in-process structural variants and controlled negative cases. It establishes a resolver baseline. The WebArena-Infinity Gmail extraction scenario additionally runs ActiveTab's native CDP capability path against the independently maintained Gmail application and compares the structured result with its isolated fixture oracle. This qualifies one pinned application and task; it does not prove an arbitrary live application's semantics or establish that its backend contains no additional records.

Fixture outcomes never authorize or prove a live-site result.
