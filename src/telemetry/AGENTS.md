# Decision Telemetry

## Purpose

Append-only, local decision lifecycle events for operational reconstruction, evaluation, and explicitly approved offline training exports.

## Local Contracts

- Keep intent, observation, semantic annotation, Jev prediction, policy disposition, dispatch, observed result, verification, correction, and independent label as distinct events.
- Record model refusals as a typed failure. A refusal or unavailable reviewer falls back to deterministic local policy; only a valid explicit `needs_agent_review` prediction pauses its proposed action.
- Preserve event order and stable episode, run, step, decision, observation, and parent IDs. Hashes detect changes; they do not provide confidentiality.
- Record the pinned model ID, provider/model version, rubric version and hash, complete typed output distribution, and usage when available.
- Persist model input fingerprints and minimized evidence references, never raw prompt/page content, form values, credentials, cookies, tokens, or model response bodies. Validate with versioned structural schemas and exact nested field sets; do not infer sensitivity by scanning text.
- Record Jev's outcome-review inputs as a separate typed projection before its prediction, linked to the independent verification event and exact evidence references.
- Semantic and Jev predictions are never ground-truth labels. Only independently verified and authenticated labels can become training-eligible.
- A training label must match a prior prediction on episode, run, step, decision, and rubric; its source code and evidence references must match an earlier same-decision verification or independently authenticated correction.
- Training approval is issued only by `DecisionEventStore` through its privately configured reviewer authenticator, supplied at runtime composition. The authenticator receives the exact proposal and returns `{ authenticated: true, principalId, approvalDigest }`; the digest must match. One proposal can receive only one approval.
- The episode builder revalidates label parentage, approval digest, reviewer identity, source outcome, and evidence references before exporting a label. Caller-created `label.approved` events are rejected by the public append path.
- Reconstruct model inputs only from explicit input-event references written before prediction. Jev's minimized structural projection and the semantic analyzer's exact structural candidate projection are retained. If semantic page labels are sent, their input event is marked excluded and semantic examples are not exported for training.
- Tests use in-memory or temporary local stores and stub model clients; never call live model endpoints.

## Verification

Run focused decision telemetry and model-client tests after changes to event schemas, privacy rules, labels, or episode reconstruction.
