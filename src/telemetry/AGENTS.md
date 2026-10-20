# Decision Telemetry

## Purpose

Append-only, local decision lifecycle events for operational reconstruction, evaluation, and explicitly approved offline training exports.

## Local Contracts

- Keep intent, observation, semantic annotation, Jev prediction, policy disposition, dispatch, observed result, verification, correction, and independent label as distinct events.
- Record model refusals as a typed failure. A refusal or unavailable reviewer falls back to deterministic local policy; only a valid explicit `needs_agent_review` prediction pauses its proposed action.
- Record secondary-planner predictions and failures with exact decision lineage, configured model, actual input modality, and typed result/failure class. OpenAI-compatible calls may include a generated client request UUID and bounded provider latency for local proxy correlation. Never retain provider error text, request bodies, screenshots, or credentials in these events.
- Workflow transport failures may retain only a fixed transport cause code and a validated HTTP status alongside request UUID and latency. Never serialize socket error text, proxy response bodies, endpoint values, or credentials.
- Semantic analyzer failures use the same bounded proxy-correlation fields and typed `size` failure class; provider and gateway error text is never retained.
- When post-action evidence cannot be re-established, `execution.reconciliation_required` records the dispatch disposition, bounded observation-attempt count, and fixed error class with the pre-action evidence reference. If an explicitly trusted live qualification reattaches the exact leased target and obtains fresh evidence, `execution.observed` records the bounded `same_target_reconnected_observation` outcome class. Neither event stores browser error text or raw page data.
- `inference.route_selected` records the bounded route, reason code, provider role(s), and whether the route used permitted visual evidence. Emit it before each model call. It is an evaluation signal only and cannot alter policy admission or grant execution authority.
- `target.lookup` records only the lookup mode/status, exact source observation and target-generation binding, bounded frame identity, returned/visited counts, fixed stop reason, elapsed milliseconds, and whether follow-on action admission is deferred, permitted, or refused. Lookup hints remain non-authorizing; never record page text, labels, coordinates, field values, or backend response bodies in this event.
- Startup model capability preflight events are training-excluded and record the role, model, authenticated catalog status/source, advertised input modalities, and effective image capability. Each inference route and input-captured event records `inputModality` as `text_only` or `text_plus_visual`; derive it from evidence actually bound to that request, never from provider capability alone.
- Preserve event order and stable episode, run, step, decision, observation, and parent IDs. Hashes detect changes; they do not provide confidentiality.
- Record the pinned model ID, provider/model version, rubric version and hash, complete typed output distribution, and usage when available.
- Usage payloads use only bounded `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, and `cost` fields. Provider-specific response keys must be normalized before append; unsupported usage fields fail schema validation.
- Persist model input fingerprints and minimized evidence references, never raw prompt/page content, form values, credentials, cookies, tokens, or model response bodies. Validate with versioned structural schemas and exact nested field sets; do not infer sensitivity by scanning text.
- `decisionEventProjections.js` owns bounded workflow, Jev, and semantic input projections. `decisionEventValidation.js` owns shared event field, enum, answer, and exact-key validation. Keep both pure; `decisionEvents.js` composes their output into the versioned event envelope.
- Record Jev's outcome-review inputs as a separate typed projection before its prediction, linked to the independent verification event and exact evidence references.
- Semantic and Jev predictions are never ground-truth labels. Only independently verified and authenticated labels can become training-eligible.
- Qualification lifecycle records are append-only and linked to the parent episode, source evidence, scenario, provider, strategy fingerprint, level, provider identity, scenario seed, source revision, oracle reference, and cleanup result. A resolver-level result cannot claim independent application qualification. A qualified result creates candidate knowledge only; it does not promote workflows or make telemetry training-eligible.
- Decision event schema version 2 added structured qualification provenance and cleanup evidence. Version 3 adds bounded typed target-lookup events; older stored version 1 and 2 events remain immutable.
- A training label must match a prior prediction on episode, run, step, decision, and rubric; its source code and evidence references must match an earlier same-decision verification or independently authenticated correction.
- Training approval is issued only by `DecisionEventStore` through its privately configured reviewer authenticator, supplied at runtime composition. The authenticator receives the exact proposal and returns `{ authenticated: true, principalId, approvalDigest }`; the digest must match. One proposal can receive only one approval.
- The episode builder revalidates label parentage, approval digest, reviewer identity, source outcome, and evidence references before exporting a label. Caller-created `label.approved` events are rejected by the public append path.
- Reconstruct model inputs only from explicit input-event references written before prediction. Jev's minimized structural projection and the semantic analyzer's exact structural candidate projection, including observation-bound semantic relationships and typed field roles, are retained. Semantic page labels and values are always removed from the event projection; if they were sent to the provider under the explicit disclosure opt-in, the input event is marked excluded and semantic examples are not exported for training.
- Jev input projections retain each bounded question's exact instructions and criteria, its rubric version/hash, and any permitted visual evidence identity/transform/digest. Screenshot bytes remain outside the event ledger; a digest alone does not qualify as a reconstructable multimodal training example.
- Tests use in-memory or temporary local stores and stub model clients; never call live model endpoints.

## Verification

Run focused decision telemetry and model-client tests after changes to event schemas, privacy rules, labels, or episode reconstruction.

## Child DOX Index

| Path | Purpose |
|------|---------|
| `decisionEvents.js` | Event type schemas, payload composition, versioned envelope, and canonical JSON |
| `decisionEventProjections.js` | Bounded workflow, Jev, visual evidence, and semantic input projections |
| `decisionEventValidation.js` | Shared bounded text/code, enum, exact-key, confidence, and answer validation |
| `eventStore.js` | Append-only event persistence, lineage queries, and authenticated training approval |
| `episodeBuilder.js` | Event lineage reconstruction and training-safe example export |
