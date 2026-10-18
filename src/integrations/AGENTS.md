# Application Integration Adapters

## Purpose

Translate application-specific typed requests into reusable ActiveTab workflows and narrowly scoped operation contracts.

## Ownership

This subtree owns application integration logic. Generic planning, browser transport, policy, execution, telemetry, and verification remain in their existing core modules.

## Local Contracts

- An adapter may translate caller-supplied intent and values; it may not invent task inputs, choose a model, expand diagnostic scope, or claim an outcome.
- Candidate mappings must reference the exact fresh observation and exact authorized target. Semantic confidence is never authority.
- Adapter operation authorization is a trusted in-process capability supplied by composition code. It must not be serialized into workflow JSON or accepted from an MCP/HTTP caller.
- Application operations still dispatch through `src/runtime/authorizedExecutor.js` and the generic `TestRunner`.
- No application adapter may report success from dispatch acknowledgement or a page change alone. An independent postcondition or diagnostic oracle is required.
- Keep browser session/authentication, semantic inference, Jev review, backend diagnostics, and application workflow translation as separate adapters.
- FreeInference task diagnostics are limited to explicitly selected run evidence. Conversation contents, credentials, and broad tenant exports are not part of the Cloud Agent task adapter.

## Work Guidance

- Add schema and boundary tests for every new application adapter.
- Keep application-specific routes, selectors, and operation IDs out of generic navigation and execution policy.
- Do not add model-generated task values or regex-based safety classification.

## Verification

```bash
node --test test/cloudAgentWorkflowAdapter.test.js
```

## Child DOX Index

| Path | Purpose |
|------|---------|
| `src/integrations/freeinference/` | FreeInference staging application workflow and its separately scoped diagnostic evidence binding |
