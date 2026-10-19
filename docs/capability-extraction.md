# Reusable Site Capabilities and Structured Extraction

ActiveTab has an end-to-end first slice for discovering visible HTML tables and repeated visible DOM record groups, compiling a trusted typed field contract, qualifying a candidate, storing a scoped recipe, collecting across bounded pagination, validating the result, and returning JSON/CSV-compatible output through the existing task API.

Repeated record groups are discovered from observed container/item tag names and exact class tokens. Their fields bind to observed tag/class-token pairs. This supports common card and list markup without accepting caller-provided selectors or arbitrary page scripts.

The DOM extractor does not yet execute API operations or traverse virtualized lists. The API discovery slice exposes separate discovery, selected-response inspection, and qualification endpoints. It can inspect only an explicitly selected, already completed same-origin GET JSON response. Qualification requires an independently scored API fixture oracle supplied by trusted composition; none is installed in the default server, so it reports unavailable by default. Qualification does not replay requests or register an executable API adapter. The model or caller cannot supply executable code or an endpoint.

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
  "publicReadEntries": [
    {
      "origin": "https://catalog.example",
      "sourceHeader": "Product name",
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

`publicReadEntries` is a separate, opt-in allowlist for one-shot reads on an explicitly attached current tab without an application profile. Entries require an exact HTTP(S) origin, one exact source header or observed source key, `dataClass: "public"`, and explicit read and release decisions. These entries cannot qualify or register a reusable capability, enable pagination, navigate the browser, or grant access to sensitive fields. The read candidate is bound in memory to the selected target, principal, document generation, source structure, and a keyed fingerprint of the full route, including its query and fragment; changing the query requires rediscovery. Query values are not placed in the candidate, output URL, log, or receipt.

`ACTIVETAB_CAPABILITY_DIR` selects the owner-private capability registry; the default is `.activetab/capabilities`. Browser execution also requires an explicit authorized session and environment profile. The API automation token does not create those bindings.

## Workflow

1. `POST /v3/capabilities/discover` returns visible table headers or repeated-group tag/class structure, row counts, route, and short-lived candidate IDs. It does not return record values.
2. For a one-time read, `POST /v3/capabilities/read` accepts the selected candidate (optional when the requested source uniquely identifies one), typed field mappings, and a record limit. The `read_page_records` MCP tool exposes the same operation. It revalidates the query-bound candidate, applies trusted classification/read/release policy, returns field provenance, and always reports `observed_partial`; it does not compile or register a recipe. Use a local application profile for profile-bound fields. Without a profile, every source field must match an exact-origin `publicReadEntries` policy entry.
   Ordinary `run_goal`/API navigation requests can also read one uniquely matched current-page HTML table through an ephemeral workflow capability. It selects only requested headers whose exact scope has trusted classification, read, and release approval. The target, principal, document generation, full query-bound route, and source structure are rechecked before reading. Output remains `observed_partial`, is not persisted as a reusable capability or durable extraction artifact, and cannot satisfy a request for all/every/complete collection coverage. This path returns already visible records; it does not navigate, submit forms, or fetch additional pages.
3. For a reusable capability, `POST /v3/capabilities/compile` supplies a capability ID, typed fields, exact-count or pagination completion policy, uniqueness keys, and bounded row/page limits. Sensitivity comes from the trusted policy file.
4. `POST /v3/capabilities/recipes/{recipeId}/qualify` runs deterministic seeded structural and negative variants. Callers cannot supply qualification evidence.
5. `GET /v3/capabilities` lists registered qualified recipes and their typed output contracts.
6. `POST /v3/capabilities/revoke` retires one exact registered capability version. The authenticated request must include its capability ID/version, origin, environment, application, principal, and a bounded reason code. The registry writes an owner-private tombstone; the revoked version disappears from listing and cannot be registered again. A replacement must use a new version and pass qualification again.

Every invocation resolves the exact scope against the current registry and takes a fresh observation. Route and application identity must still match, and the current DOM source must resolve against the registered typed contract. Missing or ambiguous sources return blocked/incomplete evidence instead of using a cached mapping. Revocation is enforced by the same registry used for retrieval; no parallel capability authority is introduced.
For repeated use, run `local-page-data-extractor` with the registered capability ID and exact registered origin/path. ActiveTab reobserves the page, resolves fresh DOM evidence, navigates only approved pagination links through the authorized executor, validates the output, applies field release policy, and returns records with provenance and completeness status.

Declarative `collect_records` steps and synthesized workflow extraction use the same `src/extraction/collectionService.js` page loop. Trusted recipes may declare same-path `rel=next`, exact-label next links/buttons, monotonic page-number query parameters, or virtualized-list scrolling with `pagination_exhausted`. Each page advance is rechecked against fresh source evidence and dispatched through the authorized executor under the current target lease. Collection requires verified progress; empty terminal pages, ambiguous controls, stalled scrolling, route drift, cycles, and page/record limits keep the result incomplete. MCP persists released partial output checkpoints separately from redacted journals. Query strings are removed from stored source routes; virtualized scrolling and same-URL button transitions resume from scratch when no safe next-cursor binding can be stored.

Observed API shapes use a separate candidate path: `POST /v3/capabilities/network/discover` lists eligible requests the page has already completed; `POST /v3/capabilities/network/candidates/{candidateId}/inspect` inspects one selected response and returns schema metadata only; `POST /v3/capabilities/network/candidates/{candidateId}/qualify` runs only when trusted composition supplied an independent API fixture oracle. These candidates are never executable or registered manifests.

The compiler supports two count contracts:

- `exact_count`: requires `expected_records`; the result must match that count.
- `pagination_exhausted`: requires explicit pagination authorization and a minimum count. It completes only after the registered pagination strategy reaches its terminal condition within the page limit.

Every record is checked for declared fields, scalar types, required values, uniqueness keys, and per-field observation provenance. Missing tables, layout drift, duplicate keys, field denial, pagination ambiguity/cycles, limits, or failed navigation cannot produce a complete output. CSV strings that begin with spreadsheet formula characters are escaped.

## Qualification limits

The built-in extraction qualifier exercises the resolver against deterministic in-process structural variants and controlled negative cases. It establishes a resolver baseline. The WebArena-Infinity Gmail extraction scenario additionally runs ActiveTab's native CDP capability path against the independently maintained Gmail application and compares the structured result with its isolated fixture oracle. This qualifies one pinned application and task; it does not prove an arbitrary live application's semantics or establish that its backend contains no additional records.

Fixture outcomes never authorize or prove a live-site result.
