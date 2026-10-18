# Decision Services

## Purpose

Bounded semantic page interpretation and Jev review. These services return evidence-linked annotations and predictions; they never authorize or dispatch browser operations.

## Local Contracts

- The semantic analyzer defaults to FreeInference Production `GLM5.3-flash` through the OpenAI-compatible provider interface. Any configured OpenAI-compatible chat-completions provider/model may fill this same annotation role.
- `OpenAICompatibleProvider.requestStructured()` supports named annotation tasks with explicit JSON Schema, JSON-object, or validated text output; one deadline covers retries, backoff, and streamed response reading. Response bytes are bounded, and cancellation/timeout remain distinct from schema errors.
- Provider capability selection affects response formatting only. It cannot promote the semantic service into an action planner or authorization authority.
- Semantic output may only reference candidates from the exact fresh observation and may not invent task values or executable actions.
- Jev is the built-in reviewer and remains pinned to `typesafe/jev-1.14`; the runtime invokes it at selected decision boundaries such as navigation transitions, task submission, privileged/uncertain actions, and recovery. Ordinary exact-value field entry and selection do not invoke Jev. Credentials load from an explicitly configured `ACTIVETAB_JEV_KEY_FILE`, a working-directory `JEV.txt`, or the owner-only home `JEV.txt`, in that order; environment keys are fallback sources. Credential files must be regular, non-symlink, owner-only files. Missing local credentials, refusal, or provider failure is recorded as an advisory failure and falls back to deterministic policy. Its credential must never appear in events, logs, or receipts.
- Jev output is advisory. It cannot override deterministic policy, grant approval, or prove an outcome. A valid `needs_agent_review` result pauses only that proposed action before dispatch; a Jev refusal, unavailable credential, timeout, or provider error is recorded and falls back to deterministic policy. A `supported` result does not admit the action.
- Semantic and Jev input fingerprints, typed outputs, model versions, rubrics, usage, failures, and observation/decision IDs are recorded as separate linked events. Structural semantic inputs are captured before the request; if page labels are enabled, their event is excluded from training because those labels are not persisted.
- The semantic request sends a bounded projection of observed roles, tags, candidate references, accessible control names, and nearby headings to the explicitly configured OpenAI-compatible endpoint. These labels are untrusted page data and are not stored in telemetry; the event store captures the structural projection and a salted input fingerprint. If labels are enabled for the request, the event is excluded from training export. Form values and URL data remain excluded by the observation contract. Do not use regular expressions or generic text scans as a privacy boundary; enforce typed field allowlists and exact nested schemas instead.

## Verification

Use stub providers in tests. Never call live model endpoints from unit tests.
