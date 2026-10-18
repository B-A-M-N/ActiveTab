# FreeInference Application Adapter

## Purpose

Compose authenticated FreeInference staging browser evidence and caller-authored Cloud Agent test requests into generic ActiveTab workflows.

## Ownership

This subtree owns the FreeInference-specific task request, fresh semantic control mapping, workflow compilation, and exact-run evidence handoff. Browser transport, policy admission, execution, decision telemetry, and verification remain owned by their core modules.

## Local Contracts

- Begin from the explicitly attached staging tab. Follow the visible Agents/Cloud Agents UI path; do not invent a destination URL or replace the authenticated browser session.
- `enter_cloud_agent` is the composable entry primitive: it follows the visible route on the attached target and verifies the real task composer before the separate task adapter can run. Entry, authentication, and task submission must remain distinguishable in receipts.
- Cloud Agent task values, selected model, expected outcome, and diagnostic source scope come from the caller. Resolve a unique structurally valid form mapping first; call semantic mapping only when the fresh observation is ambiguous. Unresolved ambiguity stops only that task. Jev reviews the task-submission boundary, not routine model selection or text entry, and cannot invent task inputs or authorize execution.
- A task outcome contract is an exact supported `run_status` value. Submit dispatch remains `UNCERTAIN` until the requested run ID is absent from pre-submit evidence, visible in later evidence from the same authorized Agents tab, and matched to the exact profile-bound backend run record.
- Jev refusal or service failure is recorded and falls back to deterministic execution policy. A valid `needs_agent_review` pauses only the proposed operation; neither result changes system availability or proves the Cloud Agent outcome.
- A control mapping must refer to the same fresh observation, selected tab, and profile-bound environment. The generic authorized executor and `TestRunner` own all effectful browser dispatch.
- A Cloud Agent task is not PASS from a UI acknowledgment or changed page. Capture the exact run identifier from fresh evidence on the same Agents tab, then use the separate diagnostic adapter for exact-run metadata only.
- Backend reads require explicit profile-validated endpoint bindings. The default profile has none; credentials and an endpoint URL alone do not authorize a request. Broad tenant lists, conversations, settings, audit exports, and sandbox inventory are not part of this task adapter.
- Keep prompts, task text, credentials, cookies, and response bodies out of decision telemetry and receipts.

## Work Guidance

- Keep FreeInference paths, operation IDs, and application roles in this adapter/profile, never in generic navigation or execution policy.
- Use stub model clients and local fixture sessions in tests. Do not create live staging jobs during ordinary unit tests.

## Verification

```bash
node --test test/cloudAgentWorkflowAdapter.test.js test/prepareCloudAgentTask.test.js test/cloudAgentAdapter.test.js test/browserRunIdentifier.test.js
```

## Child DOX Index

No child DOX boundaries.
