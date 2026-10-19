# ActiveTab Diagnostics & Evidence

## Purpose

Owns diagnostic contracts, evidence collection, correlation, and reporting.

## Ownership

ActiveTab's diagnostic evidence plane. Browser instrumentation and privileged backend diagnostics remain distinct authorities.

## Local Contracts

- Diagnostic reads require declared authority, exact scope, bounded collection, and sensitivity controls.
- The configured diagnostic service URL must exactly match the active profile binding. An endpoint URL and admin credential alone never authorize a request.
- A broad administrative GET is not inherently safe.
- Empty responses are not automatically success; semantic status must be propagated into test outcomes.
- Direct correlation requires an allowlisted event-pair rule, a verified identifier, both evidence references, and matching environment, target, run, principal, and operation scope. Probable correlation is available only through an explicit pair-specific rule; shared strings, origin, source type, and operation labels alone remain temporal or unknown.
- Backend loopback endpoints require explicit SSH-tunnel transport and verified remote target identity.
- No credentials, cookies, session tokens, or raw conversation content are forwarded to a planner by default.

## Work Guidance

- Each diagnostic source declares its contract; use typed outcomes, not exceptions alone.
- Enforce byte limits while streaming, not after reading the full response.
- Browser evidence and backend evidence must remain distinguishable.
- Selected response inspection is an evidence presentation path, not a diagnostic authority or outcome oracle. Its Markdown report, parsed shape, and body format do not verify application success. MCP may return the bounded Markdown/source/normalized projection for one explicitly selected response, with recognized credentials redacted; it never returns headers or sensitive URL data.
- Never present a temporal match as exact correlation.
- A run report is complete only when its durable terminal state matches the receipt, no effect or cleanup obligation remains unresolved, and every profile-required diagnostic source is available. Cloud Agent reports also require the exact correlated backend run record.
- MCP returns redacted bodies by default. Raw credentials, screenshots, full form values, and sensitive runtime values require a durable, separately authenticated operator grant bound to the verified principal, target, evidence, selected facet/subtree, profile application, MCP process, byte budget, and expiry. Caller-supplied booleans or a model tool call cannot approve a release. Credential values require a second grant in addition to the selected response-body grant.
- Local operator commands expose `doctor`, redacted `inspect-run`, and redacted `export-trace` views. They read local state only; trace export opens the existing telemetry database read-only and reports hash-chain integrity.
- Causal trace reports select the earliest event, by durable sequence, that proves a typed contract failed. Advisory `decision.failed` and optional `semantic.failed` events alone do not prove the run diverged. The finding carries a stable failure code, category, phase, run/step/decision/observation references, supporting evidence references, a safe next action, and an explicit automated-continuation disposition. Uncertain effects must never be advised for replay.
- `failureTaxonomy.js` owns exact stable reason-code classification and causal event interpretation. Human-readable exception text remains a compatibility fallback in the investigation engine; it does not override a provided reason code.
- Operator reports may render as recursively decomposed Markdown with complete section data blocks. `--list-sections` returns stable heading IDs and `--section ID` selects one heading subtree; the Markdown index is presentation metadata, not additional evidence.
- Trace redaction hides credentials and raw content fields while preserving numeric model-usage counters such as input/output token counts. Credential values must not be inferred from field names alone when the field clearly describes usage metadata.
- Doctor reports credential configuration presence only. It never prints credential values, credential-file paths, diagnostic endpoint values, or response bodies.

## Verification

```bash
node --test test/diagnostics.test.js test/cloudAgentAdapter.test.js test/operator-diagnostics.test.js
```

Cloud Agent adapter tests use an isolated loopback fixture and require explicit transport configuration.

## Child DOX Index

No child DOX boundaries.
