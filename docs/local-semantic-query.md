# Local Semantic Queries

`parseSemanticQuery()` and `resolveSemanticQuery()` provide a bounded local query surface over one fresh semantic-page v3 observation. They are exported from `src/navigation/semanticAnalyzer.js` and do not contact an inference endpoint.

```js
import { parseSemanticQuery, resolveSemanticQuery } from "../src/navigation/semanticAnalyzer.js";

const query = parseSemanticQuery("{ products[] { name price(number) } }");
const result = resolveSemanticQuery(observation.semanticPage, query, {
  expectedEvidence: {
    observationId: observation.evidenceId,
    targetId: observation.targetId,
    documentGeneration: observation.documentGeneration
  },
  authorizeField: field => trustedFieldPolicy.canRead(field),
  authorizeRelease: field => trustedFieldPolicy.canRelease(field)
});
```

Both policy callbacks are required for data queries and receive exact observed source identity, origin, target, and observation metadata. Do not base trusted classification on page-provided labels or role confidence. Data output includes per-record evidence references and typed resolution states, and remains `observed_partial` because semantic-page evidence cannot establish full collection completeness.

Control queries support a bounded form such as `find the search box in the main search form`. A unique result contains a fresh `targetRef` and `actionAuthorized: false`; any later action still needs normal operation authorization and dispatch through the authorized executor. Duplicate matches are returned as ambiguous.

The current DSL supports scalar arrays and common scalar types. Nested collection parsing is bounded but nested resolution reports unsupported instead of guessing record boundaries.
