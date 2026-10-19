# ActiveTab: Remaining Work

Updated 2026-10-18. This is a continuation note for the ActiveTab audit and implementation. ActiveTab remains a prototype; this is not a BrowserAct parity claim.

## Current verified state

- Browser control uses native CDP and the MV3 extension authorization path. Browser targets still require explicit authorization.
- `ACTIVETAB_HEADLESS=1` now flows from the shared qualification runtime to both default qualification drivers. A regression test checks that the native driver receives `headed:false`; the constrained-environment setting is explicit and is not a silent fallback.
- The latest full suite run reported **613 tests, 610 passed, 0 failed, and 3 skipped** with `npm test`. The skips are environment-dependent integration qualifications. The run needed host access for disposable Chrome and loopback integration tests.
- Selected response inspection now handles JSON-like bodies with coercion/repair attempts and safe parse diagnostics, and runs format-aware scans for non-JSON content such as markup, YAML, delimited data, event streams, and log-like text. A failed parse stays a parse failure; repair metadata records what interpretation was attempted.
- Complex diagnostics use Markdown as a common display and decomposition layer after format-aware interpretation. Typed parse evidence, provenance, repair diagnostics, credential metadata, and the complete redacted bounded source remain linked from indexed headings, sections, tables, and fenced blocks; operator diagnostics use the same structured-to-Markdown decomposition. Trusted local callers can select a section or block and page through it. CSV/TSV reports include the complete safe source after bounded preview tables. Markdown simplifies navigation and sharing across formats without replacing the format-aware analysis or evidence source.
- Response paging now builds a sparse UTF-8 offset index and reuses sequential cursors. A five-minute bounded cache retains only redacted projections and reuses them across section/page requests; full credential-value and sensitive-URL requests bypass it. Local synthetic ASCII measurements with unaligned 32,719-byte pages: 1 MiB/33 pages took 9 ms to index and 5 ms to page versus 143 ms with the prior prefix scan; 4 MiB/129 pages took 15 ms to index and 7 ms to page versus 2,115 ms with the prior scan. The fourfold input increase produced roughly 1.5× indexed total time. These timings cover string paging only, not CDP acquisition or peak memory.
- Application profiles may register trusted native `fill`/`select` operation IDs for an exact application. The workflow engine now wires those capabilities only after application resolution, binds their authority to caller `inputRef` values and fresh target evidence, and includes the operation binding in resume fingerprints. No staging profile opts into these form operations yet.
- Diagnostic inspection is bounded and local. Recognized credential fields get structural metadata (location, kind, size, encoding clues, and token shape) without duplicating values. MCP returns selected response bodies as redacted, decomposable diagnostics; raw credentials, screenshots, full form values, and sensitive runtime values require an independent operator grant. Grants bind the local OS principal, MCP process, verified profile application, target, evidence, exact facet/Markdown selection, byte budget, and expiry; raw credentials require separate body and credential grants. Headers and sensitive URL data remain unavailable through MCP. Credential recognition is best effort; opaque or compressed binary content cannot be fully classified by text patterns.
- Fixture Lab qualification now records qualification level and provenance. Synthetic resolver results cannot claim independent application outcomes. The local WebArena-style app has an independent oracle; this does not qualify the live FreeInference staging application.
- One serial, headed, anonymous public-site qualification completed through the configured local FreeInference proxy: DuckDuckGo search to an observed Wikipedia result, real GLM-5.3-Flash and Jev 1.14 image-capability preflight, image-bound calls to both models, schema-validated GLM planning, and independent visible-page plus HTTP verification. The result was cross-source verified and browser, profile, lease, and temporary run-state cleanup all passed. This validates the public read-only route and model integration; it does not qualify staging workflows, MCP evidence release, or the target-reattachment branch, which was covered by focused regression tests but not needed in that live run.

## Audit disposition

| Finding | State |
|---|---|
| AT01 exact-value workflow planning | Fixed |
| AT02 application resolution and stale-route checks | Fixed |
| AT03 link destination verification | Fixed |
| AT04 pair-specific diagnostic correlation | Fixed |
| AT05 screenshot-region to DOM grounding | Partial; deterministic bounds help, but full visual grounding is absent |
| AT06 generic safe form capabilities | Partial; reusable native fill/select capabilities and exact-application profile wiring are implemented; no staging profile opts in, and end-to-end qualification remains outstanding |
| AT07 shared page collector | Implemented |
| AT08 virtualized lists and cursor adapters | Incomplete |
| AT09 qualification level and provenance enforcement | Implemented locally; public read-only qualification passed, while staging qualification remains outstanding |
| AT10 separately authorized MCP evidence release | Implemented locally with adversarial scope, caller-process, expiry, revocation, and byte-budget coverage; live MCP release qualification remains outstanding |
| AT11 response inspection and resource bounds | Implemented locally: bounded format parsers, sparse byte indexing, UTF-8-safe cursor paging, and bounded redacted projection reuse. Tests cover 8 MiB reconstruction, random Unicode offsets including combining marks, cache eviction, cancellation, target-change rejection, exact section reconstruction, and no repeated CDP body read. CDP still materializes the selected response as one whole protocol result; peak-memory and adversarial hard-work behavior need measurement |
| AT12 application run lifecycle convergence | Partial |
| AT13 caller-granted upload file scope | Incomplete |
| AT14 composite select handling | Implemented |
| AT15 shared action limits | Implemented |
| AT16 tiered observation profiles and metrics | Implemented |

## Remaining work, in priority order

1. Qualify diagnostic collection and identifier correlation against the authorized live FreeInference staging application, with independent outcome evidence and cleanup verification.
2. Qualify native form capabilities against an explicitly authorized application profile, then add screenshot-to-DOM grounding, virtualized-list support, and cursor adapters without weakening policy admission or target authorization.
3. Qualify the separately authorized MCP evidence-release contract through the intended local operator workflow. Keep adversarial scope-mismatch, caller-process, expiry, revocation, and byte-budget checks in regression coverage. Raw credential release requires both body and credential grants.
4. Measure response acquisition, parsing, decomposition, cancellation, and peak memory on large and adversarial bodies. `Network.getResponseBody` yields the selected body as one protocol result, so post-retrieval size checks do not by themselves bound acquisition memory.
5. Complete application-run lifecycle convergence and add caller-scoped file grants for uploads, including symlink and path-boundary checks.
6. Run held-out application, browser-version, frame, and long-duration qualification. Recheck external-provider and visible-extension flows when their required environments are available.
7. Run a paired BrowserAct SaaS baseline only if access and a workflow ID are provided; use identical task state, failure injection, and independent outcome oracles.

## Claim gate

Do not claim BrowserAct parity or completed reverse engineering until the hosted baseline (if authorized), held-out-site evaluation, external staging qualification, and unresolved capability limits above are addressed. Keep observed behavior, verified implementation, architectural inference, and unknown behavior separate.
