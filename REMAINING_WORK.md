# ActiveTab: Remaining Work

Updated 2026-10-19. This is a continuation note for the ActiveTab audit and implementation. ActiveTab remains a prototype; this is not a BrowserAct parity claim.

## Current verified state

- Browser control uses native CDP and the MV3 extension authorization path. Browser targets still require explicit authorization.
- `ACTIVETAB_HEADLESS=1` now flows from the shared qualification runtime to both default qualification drivers. A regression test checks that the native driver receives `headed:false`; the constrained-environment setting is explicit and is not a silent fallback.
- Newly launched owned Chrome windows and headed browser tests now default to the secondary display. The desktop map is main `eDP-1` at physical `(0,0)`, 2880×1620, and secondary `HDMI-1` at `(2880,0)`, 2560×1440. Chrome's logical position `(1440,0)` was verified against X11 window geometry at physical x=2880. Use `ACTIVETAB_CHROME_DISPLAY=main` or `npm run test:on-main` to switch screens.
- The latest full serial suite reported **755 tests, 752 passed, 0 failed, and 3 skipped** with `npm test -- --test-concurrency=1` on the secondary display. The run required host access for headed disposable Chrome and loopback integration tests.
- Selected response inspection now handles JSON-like bodies with coercion/repair attempts and safe parse diagnostics, and runs format-aware scans for non-JSON content such as markup, YAML, delimited data, event streams, and log-like text. A failed parse stays a parse failure; repair metadata records what interpretation was attempted.
- Complex diagnostics use Markdown as a common display and decomposition layer after format-aware interpretation. Typed parse evidence, provenance, repair diagnostics, credential metadata, and the complete redacted bounded source remain linked from indexed headings, sections, tables, and fenced blocks; operator diagnostics use the same structured-to-Markdown decomposition. Trusted local callers can select a section or block and page through it. CSV/TSV reports include the complete safe source after bounded preview tables. Markdown simplifies navigation and sharing across formats without replacing the format-aware analysis or evidence source.
- Response paging now builds a sparse UTF-8 offset index and reuses sequential cursors. A five-minute bounded cache retains only redacted projections and reuses them across section/page requests; full credential-value and sensitive-URL requests bypass it. Local synthetic ASCII measurements with unaligned 32,719-byte pages: 1 MiB/33 pages took 9 ms to index and 5 ms to page versus 143 ms with the prior prefix scan; 4 MiB/129 pages took 15 ms to index and 7 ms to page versus 2,115 ms with the prior scan. The fourfold input increase produced roughly 1.5× indexed total time. These timings cover string paging only, not CDP acquisition or peak memory.
- Application profiles may register trusted native `fill`/`select` operation IDs for an exact application. The workflow engine now wires those capabilities only after application resolution, binds their authority to caller `inputRef` values and fresh target evidence, and includes the operation binding in resume fingerprints. No staging profile opts into these form operations yet.
- A detached post-click CDP session can recover through the shared CLI/HTTP/MCP composition only for the same loopback endpoint and target ID under the current durable lease. Fresh authorized-origin evidence is required before rebinding, and the click is never replayed. A real local Chrome integration test exercises this failure path.
- Diagnostic inspection is bounded and local. Recognized credential fields get structural metadata (location, kind, size, encoding clues, and token shape) without duplicating values. MCP returns selected response bodies as redacted, decomposable diagnostics; raw credentials, screenshots, full form values, and sensitive runtime values require an independent operator grant. Grants bind the local OS principal, MCP process, verified profile application, target, evidence, exact facet/Markdown selection, byte budget, and expiry; raw credentials require separate body and credential grants. Headers and sensitive URL data remain unavailable through MCP. Credential recognition is best effort; opaque or compressed binary content cannot be fully classified by text patterns.
- Fixture Lab qualification now records qualification level and provenance. Synthetic resolver results cannot claim independent application outcomes. The local WebArena-style app has an independent oracle; this does not qualify the live FreeInference staging application.
- One serial, headed, anonymous public-site qualification completed through the configured local FreeInference proxy: DuckDuckGo search to an observed Wikipedia result, real GLM-5.3-Flash and Jev 1.14 image-capability preflight, image-bound calls to both models, schema-validated GLM planning, and independent visible-page plus HTTP verification. The result was cross-source verified and browser, profile, lease, and temporary run-state cleanup all passed. This validates the public read-only route and model integration; it does not qualify staging workflows, MCP evidence release, or public-site target reattachment.
- A bounded retained-control lookup now searches the exact retained observation and compact internal candidates, reports incomplete/budget stop states, and never grants action authority. On partial-coverage ambiguity, navigation may use its result only as a hint, then takes fresh ordinary interaction evidence and re-derives the action. Element queries do not claim absence or uniqueness from incomplete candidate/frame coverage.
- Text replacement revalidates the exact focused candidate before delivery and after selection; nonempty replacement avoids a pre-delete, and resulting values are read back. Semantic page projection keeps controls and meaningful regions through deep generic wrappers and adds bounded evidence-reference relationships for supported labels and ARIA controls/ownership.
- The full serial suite passed with no `.env.local` injection on the configured secondary display: **766 passed, 0 failed, 3 skipped** (`ACTIVETAB_CHROME_DISPLAY=secondary node --test --test-concurrency=1`). The npm test script that loads `.env.local` separately produced 702 passed, 64 failed, 3 skipped; those failures were in environment-sensitive model/image-configuration expectations. Use `npm run test:headed -- --xvfb` for future browser testing isolated from physical pointer and desktop focus; it is graphically rendered but not visible on HDMI-1.

## Audit disposition

| Finding | State |
|---|---|
| AT01 exact-value workflow planning | Fixed |
| AT02 application resolution and stale-route checks | Fixed |
| AT03 link destination verification | Fixed |
| AT04 pair-specific diagnostic correlation | Fixed |
| AT05 screenshot-region to DOM grounding | Implemented locally with root/frame candidate matching and freshness checks; held-out and live-site qualification remain outstanding |
| AT06 generic safe form capabilities | Partial; reusable native fill/select capabilities and exact-application profile wiring are implemented; no staging profile opts in, and end-to-end qualification remains outstanding |
| AT07 shared page collector | Implemented |
| AT08 virtualized lists and cursor adapters | Partial; virtualized scrolling and registered paging are implemented, while safe virtualized resume cursors and same-URL button paging remain unsupported |
| AT09 qualification level and provenance enforcement | Implemented locally; public read-only qualification passed, while staging qualification remains outstanding |
| AT10 separately authorized MCP evidence release | Implemented locally with adversarial scope, caller-process, expiry, revocation, and byte-budget coverage; live MCP release qualification remains outstanding |
| AT11 response inspection and resource bounds | Implemented locally: bounded format parsers, sparse byte indexing, UTF-8-safe cursor paging, and bounded redacted projection reuse. Tests cover 8 MiB reconstruction, random Unicode offsets including combining marks, cache eviction, cancellation, target-change rejection, exact section reconstruction, and no repeated CDP body read. CDP still materializes the selected response as one whole protocol result; peak-memory and adversarial hard-work behavior need measurement |
| AT12 application run lifecycle convergence | Partial; durable run state and exact-target CDP reattachment are covered locally, while broader lifecycle convergence remains outstanding |
| AT13 caller-granted upload file scope | Implemented locally with configured roots, source/stage hashing, scoped one-use grants, and symlink/path-boundary checks; live application qualification remains outstanding |
| AT14 composite select handling | Implemented |
| AT15 shared action limits | Implemented |
| AT16 tiered observation profiles and metrics | Implemented |

## Remaining work, in priority order

1. Qualify diagnostic collection and identifier correlation against the authorized live FreeInference staging application, with independent outcome evidence and cleanup verification.
2. Qualify native form capabilities, visual grounding, virtualized-list handling, and pagination against explicitly authorized held-out applications without weakening policy admission or target authorization. Add a safe virtualized resume cursor and same-URL button adapter if the required freshness and completion evidence can be established.
3. Qualify the separately authorized MCP evidence-release contract through the intended local operator workflow. Keep adversarial scope-mismatch, caller-process, expiry, revocation, and byte-budget checks in regression coverage. Raw credential release requires both body and credential grants.
4. Measure response acquisition, parsing, decomposition, cancellation, and peak memory on large and adversarial bodies. `Network.getResponseBody` yields the selected body as one protocol result, so post-retrieval size checks do not by themselves bound acquisition memory.
5. Complete the remaining application-run lifecycle convergence work and qualify caller-scoped upload grants against an explicitly authorized application.
6. Run held-out application, browser-version, frame, and long-duration qualification. Recheck external-provider and visible-extension flows when their required environments are available.
7. Run a paired BrowserAct SaaS baseline only if access and a workflow ID are provided; use identical task state, failure injection, and independent outcome oracles.
8. Define a bounded, target-scoped native accessibility/hit-probe contract before implementing live probing. The current retained lookup intentionally does not traverse unrestricted live AX or issue desktop input.
9. Add a dedicated decision event for retained-lookup attempt counts and stop reasons if operational telemetry is required; current results expose bounded visit/result counts directly.

## Claim gate

Do not claim BrowserAct parity or completed reverse engineering until the hosted baseline (if authorized), held-out-site evaluation, external staging qualification, and unresolved capability limits above are addressed. Keep observed behavior, verified implementation, architectural inference, and unknown behavior separate.
