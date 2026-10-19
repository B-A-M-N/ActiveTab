# Semantic observation baseline on public websites

Run date: 2026-10-19

This is a read-only baseline of ActiveTab's native CDP interaction observation and local candidate selection on four public websites. It did not use Fixture Lab, a hosted fixture, a model call, or a browser action. Each page opened in a fresh headed owned Chrome process and was observed after a two-second settle. The refreshed run exercised semantic-page schema version 3.

Reproduce with:

```bash
npm run benchmark:semantic-observation
```

The command visits only the four fixed URLs in `scripts/benchmark-semantic-observation.mjs`. Capture duration excludes Chrome startup and the two-second settle. Public page content and browser evidence are summarized to stdout and are not written to a receipt or dataset.

## Results

| Public page and task | Observed candidates | Task scope returned | Page type | Controls bound to records | Capture |
|---|---:|---:|---|---:|---:|
| [Open Library search](https://openlibrary.org/search?q=computer+vision) — find computer-vision books and authors | 382 | 159 / 159 | `repeated_content` (inferred) | 137 | 1,519 ms |
| [NASA News](https://www.nasa.gov/news/) — find the latest Mars mission story | 308 | 76 / 76 | `repeated_content` (inferred) | 4 | 989 ms |
| [MDN form reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form) — find form attributes | 912 | 149 / 149 | `article` (inferred) | 1 | 2,726 ms |
| [Wikipedia neural-network article](https://en.wikipedia.org/wiki/Neural_network) — read its history section | 280 | 57 / 57 | `article` (inferred) | 7 | 312 ms |

All four pages exceeded the 200-candidate response bound. Each current task scope fit within that bound and was marked complete, while whole-page coverage remained explicitly partial. The compiler linked controls to regions, forms, and visible collections, then bound controls to specific repeated records where the repeated sibling group was unique. Repeated-record storage keys remain generic `field_n`; supported fields can additionally carry observed labels and inferred semantic roles. Collection completeness remained unknown. Capture took 312–2,726 ms and serialized evidence ranged from 838,466 to 3,014,193 bytes.

### Shared-index timing rerun

A later headed rerun on the same four public URLs exercised the per-observation shared `documentIndex` and emitted phase timings. The site contents and candidate counts changed between runs, so these are instrumentation samples, not a controlled before/after comparison.

| Public page | Page candidates | Task scope | Document indexes | Index build | Candidate derivation | Semantic compile | Capture | Serialized evidence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Open Library | 373 | 157 / 157 | 2 | 27.9 ms | 67.2 ms | 100.1 ms | 1,220 ms | 1,683,160 B |
| NASA News | 308 | 76 / 76 | 1 | 10.5 ms | 35.7 ms | 25.3 ms | 263 ms | 851,875 B |
| MDN form reference | 904 | 149 / 149 | 3 | 34.4 ms | 169.7 ms | 142.4 ms | 1,982 ms | 2,971,218 B |
| Wikipedia article | 280 | 57 / 57 | 1 | 2.8 ms | 24.0 ms | 13.2 ms | 450 ms | 1,370,632 B |

The indexed-document count reflects the root document plus captured out-of-process frames. Heap and RSS deltas are process-wide before/after readings and are too noisy to attribute to indexing; this run does not establish an allocation reduction. The Open Library scope also differed from an earlier capture of the changing live page (465 candidates and incomplete coverage), so complete scope in this rerun is not evidence that candidate recall improved. A controlled same-snapshot baseline is still required for performance claims.

### Live rerun after record-context ranking

A headed rerun after adding local table-row, list-item, and article text to candidate ranking again used only the four actual public sites. The default sandbox could not start Chrome, so the same read-only command was retried with sandbox escalation. The successful command made zero model calls and zero browser actions; it only captured and summarized fresh DOM/AX evidence.

Open Library exposed 382 candidates and a task scope of 270, while the response limit returned 200. `scopeCoverage` was correctly `incomplete`; capture took 222 ms and serialized 1,796,161 bytes. NASA exposed 308 candidates with a complete 89/89 task scope (95 ms capture, 861,459 bytes). Wikipedia exposed 280 candidates with a complete 74/74 scope (252 ms capture, 1,405,561 bytes). MDN also observed successfully, but its exact summary row was beyond the captured tool-output window.

The Open Library result shows that preserving the controls tied to every matching record can exceed the current 200-candidate bound. ActiveTab did not report complete coverage. This is a concrete remaining usability gap: the system needs localized semantic selection or bounded follow-up observation to resolve large matching collections. Live page content changed between runs, so these samples are not a controlled performance comparison.

The compiler now reports conservative broad page shapes, native interaction mechanics, and evidence-linked semantic field roles when explicit metadata, associated accessible labels, description-list terms, or stable names support them. A label remains marked observed while a role inferred from its wording remains inferred; ambiguous duplicate-ID label references remain unknown. Unrecognized or unstable field names remain unknown. The model projection carries those signals, along with exact record-to-control relationships, while application operation meaning and effect remain unknown.

Schema-v3 repeated-record descriptors now also retain the exact bounded source-group and field source-key/tag bindings locally. The planner and workflow model projections deliberately omit those locators. An explicit one-shot read goal can select fields by a supported semantic role or label and receive an ephemeral visible-card extraction capability after the trusted field policy independently approves every requested field. The result remains `observed_partial`. Focused regression tests cover a card list, ambiguous bindings, denied fields, route drift, and locator omission from both model projections; this behavior has not yet been qualified on a live card listing.

## What this establishes

- Native CDP observation and local lexical task ranking can put relevant controls near the front of a bounded candidate set on four unfamiliar public sites: book search, news, technical documentation, and a reference article.
- Page coverage and task-scope coverage are different facts. The observation records each independently and refuses to call an oversized task scope complete.
- Semantic region, form, and collection links are useful structural evidence for planning and extraction.
- On this sample, 149 controls were linked to exact repeated records across the Open Library, NASA, MDN, and Wikipedia pages. This establishes that the mapping works on these captured DOM structures, not that every control or record was mapped correctly.
- Interaction capture took 312–2,726 ms on these four captures, after navigation had settled. This excludes browser startup, site loading, inference, and action time.

## What it does not establish

- Task-scope completeness is based on local lexical and structural selection, not an independent oracle for every possible relevant control. It does not prove that the scope contains the full meaning of the user's request.
- Broad page types are structural heuristics. An article or listing with unusual markup may be classified as `unknown` or assigned the wrong broad class; the four pages are not an independent classification benchmark.
- Repeated-structure discovery can include unrelated card groups; repeated-record labels may remain `field_n`; table visibility counts can be zero or incomplete; accessible labels can be noisy. A collection candidate is not a typed, complete record set.
- No navigation, extraction result, workflow completion, or model decision was qualified by this observation-only run.
- The run sampled four pages once each. It is not a representative estimate of arbitrary websites or end-to-end latency. The MDN page and live content changed between the previous capture and this run, so these measurements are not a controlled before/after benchmark.

The next semantic-model work is to qualify record-field names and binding quality across more public page structures, and compare the page/interaction classes with reviewed labels. A class should remain `unknown` when structural evidence does not support one; inferred page or operation meanings must never become execution authority.

## Separate live model and browsing qualification

On 2026-10-19, `public-search-wikipedia-001` ran separately in headed owned Chrome. The run searched DuckDuckGo for a randomly selected neutral topic, let GLM-5.3-Flash select an observed Wikipedia result from text and screenshot evidence, and sent the same fresh public-page observation to Jev 1.14 for an advisory obstruction assessment. Preflight reported text and image input for both routes. The independent Wikipedia check returned HTTP 200 and matched the visible heading and requested topic.

That run completed with `verified_success`, two inference attempts, two screenshot captures, 11 observations, 22.1 seconds elapsed, and verified cleanup. It used no hosted application or Fixture Lab. This is evidence that both configured inference routes and the authorized browser path were invoked against a real public site; one successful run does not establish general model accuracy or semantic page-type classification.

## Live semantic-page extraction

On 2026-10-19, a headed owned Chrome session opened the real Wikipedia UN population table and ran an ordinary natural-language read request through ActiveTab's workflow path and configured GLM-5.3-Flash route. The table exposed a country field and a 2023 population field. The synthesized extraction step passed after one model inference attempt and returned 100 DOM-grounded rows with per-field provenance.

The result was explicitly `observed_partial`, with `overflow: true` and `completionReasonCode: "visible_record_limit_reached"`. It made no completeness claim and did not paginate or mutate the page. A one-time Wikipedia canonical path redirect was observed before the route settled; the live run waited for stable route evidence before task planning. The read used an exact-origin, per-source public field allowlist for this qualification.

This run demonstrated real-site semantic planning and typed extraction through the model route, not an independent truth oracle for every returned row or full-collection completeness. The first visible records were World (`8,091,734,930`) and India (`1,438,069,596`) for the 2023 population field. The same live case exposed a verifier bug that rejected record-limit overflow even when the output was explicitly partial; the verifier now accepts only the bounded `observed_only` overflow contract and continues to reject overflow for complete results.

## Latest live navigation failure

A separate headed public search run on 2026-10-19 invoked GLM-5.3-Flash once with text and screenshot evidence and received a candidate-bound Wikipedia-link prediction. ActiveTab dispatched the admitted same-tab navigation, then lost the CDP target during post-action observation. It stopped unresolved without retrying the browser action or claiming success. The run receipt marked cleanup unverified. I confirmed no Chrome process remained for that run and removed its exact owner-only temporary profile; the durable receipt remains an accurate record that the runner itself could not verify cleanup. Same-tab target reattachment remains an end-to-end reliability gap.

A second headed run on 2026-10-19 repeated the random DuckDuckGo search and made one actual GLM-5.3-Flash request with text plus screenshot evidence. The model returned a candidate-bound Wikipedia link and ActiveTab dispatched one admitted same-target navigation. The CDP target detached before post-action observation, so the browser result and requested topic could not be independently verified; the receipt is `agent_error` with no verification result. Preflight reported Jev image support, but this run did not request Jev. The receipt again records cleanup as unverified. Afterward, I confirmed that no Chromium process referenced the run's temporary profile and removed the exact owner-only profile. That later filesystem reconciliation does not change the run-time cleanup status in its receipt. This independent live attempt reproduces the same navigation/reattachment failure, while proving that the real model invocation and headed browser dispatch occurred.

A third headed run on 2026-10-19 completed the same public search-and-browse scenario with `verified_success`. It made one actual GLM-5.3-Flash request using text and screenshot evidence, performed the admitted same-target Wikipedia navigation, and passed the independent cross-source check. The run took 14.0 seconds and verified browser shutdown, temporary-profile removal, lease release, and run-state cleanup. Its receipt is `db1cadf9-318b-4f1e-85bd-13f8801f4c15`. This confirms one successful end-to-end run after two target-detach failures; it does not establish that the reattachment failure is resolved or qualify repeated-card extraction.

## Semantic-page v3 live planner probe

On 2026-10-19, a headed, disposable Chrome session opened a real DuckDuckGo result page and passed the fresh DOM/AX observation plus bound screenshot through the configured FreeInference proxy to GLM-5.3-Flash. The single model request included the semantic-page v3 projection and a `name` field role. GLM returned a candidate-bound plan in 5.95 seconds. The probe did not dispatch the proposed action and verified browser cleanup. A separate read-only Open Library probe returned an ambiguous local plan before inference, so it did not establish that the model can resolve every unfamiliar public listing.

A later headed, owned-Chrome run opened the real Open Library computer-vision results and sent one text-only workflow-synthesis request through the configured FreeInference proxy to GLM-5.3-Flash. The model selected the run-local observed-record extraction capability; ActiveTab returned 20 visible title/author records as `observed_partial`, with duplicate titles preserved and no completeness claim. Browser effects were explicitly denied for the run, and browser shutdown, temporary-profile removal, lease release, and temporary state cleanup all verified. This establishes one end-to-end model-backed extraction from a real public listing; it does not verify every row against an independent catalogue or establish collection completeness.

The live run exposed that ephemeral reads had treated the first requested display field as a uniqueness key. Two distinct Open Library records shared a title, causing valid visible data to be rejected. Ephemeral partial reads now make no uniqueness assertion unless the caller supplies an explicit key; complete registered extraction still requires a uniqueness contract. The corresponding regression preserves two same-title, different-author records.

## Bounded candidate-scope expansion

A later headed, read-only benchmark run used the same four real public URLs after adding one demand-driven follow-up observation for an incomplete task scope. The second observation is bounded to 384 candidates and is attempted only when the initial scope is incomplete and contains no more than 384 candidates; larger scopes remain incomplete. This run made no model calls or browser actions.

Open Library returned 200 candidates from a 578-candidate task scope, so the bounded follow-up was correctly skipped and coverage remained incomplete. This shows the guard preserves truthful coverage, but also leaves dense public listings above the 384-candidate ceiling unresolved. The expansion is an intermediate mitigation, not a complete solution to semantic localization on dense pages.

## Local inference-proxy failure during live qualification

A separate headed run of `public-search-wikipedia-001` opened the real DuckDuckGo search page, completed the admitted search action, and attempted one GLM-5.3-Flash request with text and screenshot evidence. The request did not reach the model: ActiveTab recorded `failureCode: transport`, and the local gateway returned HTTP 503 after 25 seconds with `ALL_PROVIDER_CIRCUITS_OPEN` and `physical_attempt_count: 0`. The run stopped before Wikipedia navigation with `agent_error` / `live_search_unresolved`; cleanup was verified. The receipt is `acef92c4-471f-46e6-8abf-b6a242709996` and the ActiveTab client request ID is `f69d3dc9-1ba3-4678-9819-cf47f6a3b281`.

The configured model endpoint resolves to the local `FI-gateway-release` process on `127.0.0.1:18769`. Its matching log entry shows a 25,001 ms gateway wait, HTTP 503, `ALL_PROVIDER_CIRCUITS_OPEN`, and zero physical upstream attempts. A read-only gateway status snapshot showed no active or queued requests, `health_state: healthy`, but the GLM circuit still `HALF_OPEN`; the last rejection reason was `provider_circuit_open`. The gateway's recent physical-attempt history includes connection and TLS-classified failures before repeated requests were rejected without reaching FreeInference. This identifies the local gateway circuit/admission layer as the immediate failure point; it does not establish a current FreeInference provider outage.

Startup model preflight currently reads model catalogs to identify supported input modalities. A catalog result such as `available` establishes advertised capability, not that an inference request can currently pass the local proxy. The live run is direct evidence of that distinction: catalog preflight reported GLM text and image support, while the subsequent inference was rejected locally before any provider attempt. No gateway state was changed during diagnosis.

A subsequent headed run on 2026-10-19 reproduced the proxy failure with fresh request correlation. ActiveTab completed the real DuckDuckGo search, captured a screenshot, and dispatched one GLM-5.3-Flash text-plus-visual request. The gateway waited 25,015 ms and rejected it with HTTP 503 / `ALL_PROVIDER_CIRCUITS_OPEN`; its matching log entry (`b0d9e48874e6`) records zero physical upstream attempts. The run stopped before Wikipedia navigation, returned `agent_error` / `live_search_unresolved`, and verified cleanup. Receipt: `f2c5247c-ba12-4aa8-bd72-873857e2c13d`; ActiveTab client request ID: `3893c244-2721-4094-a1fd-23c7cd46ef72`.

A read-only status snapshot during diagnosis reported `health_state: healthy`, `availability_state: HALF_OPEN`, zero active and queued requests, and `last_rejection_reason: provider_circuit_open`. Nearby gateway history shows earlier upstream connection-reset and TLS-classified failures before circuit admission began rejecting calls without an upstream attempt. This confirms the immediate failure occurs inside local gateway admission after those transport failures; the latest ActiveTab payload was not delivered to FreeInference. It does not by itself determine whether the circuit's recovery/probe behavior is faulty or whether the upstream transport condition persists. The gateway was not modified.

The workflow synthesizer also now uses compiled record relationships to narrow a specific item request. It keeps controls bound to the best-matching record or tied records, retains collection-level controls, and excludes controls bound to unrelated records in that collection. A local contract test covers this projection. This is a regression pretest, not live-site qualification; the live Open Library scope above remains unresolved at 578 candidates and has not yet demonstrated this new record-bound selection against a public listing.

## Latest live GLM and Jev visual run

One serial, headed `public-search-wikipedia-001` run on 2026-10-19 enabled Jev visual review. ActiveTab searched the real DuckDuckGo site and captured fresh screenshot evidence. Jev 1.14 received text plus visual input and returned two typed advisory answers in one review: obstruction probability `0.1` and obstruction type `none` at confidence `0.98`. Those answers did not authorize an action. ActiveTab then sent GLM-5.3-Flash one text-plus-visual planning request. No planner prediction arrived, so Wikipedia browsing did not start. The receipt is `23287917-23a9-4f2f-8e10-9689279227b0`; cleanup, including headed Chrome shutdown, profile removal, lease release, and run-state removal, was verified.

The GLM client request ID `53c2113c-ca2e-4868-9950-0191b15bba15` correlates to local gateway request `0180a52e5b1e`: after 25,001.9 ms, the gateway returned HTTP 503 with `ALL_PROVIDER_CIRCUITS_OPEN`, `retry_admission_reason: provider_circuit_open`, `admission_state: rejected`, `upstream_status: 0`, and `physical_attempt_count: 0`. The gateway's current safe status snapshot still reports GLM `HALF_OPEN` after `cooldown_elapsed`, no active or queued work, and a prior `connection` failure with status 0. This confirms Jev's visual route worked while GLM was refused by the local FI gateway before any upstream attempt. Catalog preflight advertised GLM image support but did not test inference reachability; startup and runtime-capability output now labels this as `inferenceReachability: not_probed`. The gateway status snapshot does not expose its half-open probe counter, so the evidence cannot distinguish an occupied probe slot from another admission-path cause. No gateway state or code was changed.

## Deterministic semantic read on a live public table

On 2026-10-19, headed owned Chrome opened the live Wikipedia United Nations population table. ActiveTab's ordinary `NavigationEngine` auto path matched the caller's `country names` and `2023 population` request to the observed table, compiled canonical `country` and `population` fields, and ran one local extraction step. It made zero synthesis calls and dispatched zero browser actions after page load. The exact observed source headers remained in the per-field policy and provenance metadata.

The result contained 100 rows and was marked `observed_partial`; it made no full-collection claim and did not paginate. The first rows were World (`8,091,734,930`), India (`1,438,069,596`), and China (`1,422,584,933`). Browser shutdown and disposable-profile removal both verified. This run demonstrates a real-site deterministic read through the normal engine without using a hosted fixture or calling either inference model. It does not independently validate every returned row or establish general performance on arbitrary pages.

## HDMI-1 observation rerun and display verification

On 2026-10-19, the fixed four-site observation benchmark ran in headed owned Chrome on `HDMI-1`. The display map is `eDP-1` main at physical `(0,0)`, `2880×1620`; `HDMI-1` secondary at physical `(2880,0)`, `2560×1440`. Chrome's device scale factor was `2`; final CDP bounds were `(1440,0)` device-independent pixels and `window.screenX * devicePixelRatio` equaled physical x=`2880`. The run made zero model calls and zero browser actions.

The table combines successful per-site results from two benchmark runs: the later rerun timed out only on the Open Library navigation, so its successful sample is from the immediately preceding HDMI-1 run.

| Site | Observed candidates | Task scope | Scope | Page type | Capture | Evidence |
|---|---:|---:|---|---|---:|---:|
| Open Library search | 362 | 250 / 250 | complete | repeated content | 1,215 ms | 1,835,564 B |
| NASA News | 308 | 89 / 89 | complete | repeated content | 1,528 ms | 859,214 B |
| MDN form reference | 541 | 137 / 137 | complete | article | 2,377 ms | 1,202,667 B |
| Wikipedia neural-network article | 280 | 74 / 74 | complete | article | 1,025 ms | 1,450,776 B |

The requested Open Library query redirected to `https://openlibrary.org/search` with the query removed; the page showed a 20-book microdata collection. This does not reproduce the prior 578-candidate `computer vision` task scope, and the current 250/250 scope does not prove a same-page improvement. A second identical capture later timed out during `Page.navigate` on Open Library; it dispatched no action and the disposable browser was cleaned up. NASA, MDN, and Wikipedia were observed in that second capture as well.

These were observation-only runs. They do not qualify search navigation, form submission, frame interaction, virtualized scrolling, extraction correctness, or independent application outcomes. The earlier Wikipedia table read above is a separate real-site extraction, returned `observed_partial`, and did not paginate. The sample still lacks a public-site qualification for a frame-heavy workflow and a practical infinite/virtualized collection.
