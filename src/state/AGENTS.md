# ActiveTab State and Artifacts

## Purpose

Own bounded local task journals, resumable MCP extraction artifacts, durable run-state records, and opt-in reusable workflow traces.

## Local Contracts

- MCP task journals contain bounded resume metadata only. They omit raw goals, browser evidence, form values, cookies, authentication material, extracted record values, and raw cursor URLs.
- A target's trusted `journalEndpoint` may preserve an existing MCP journal key when its actual loopback CDP endpoint becomes available. Use the actual `endpoint` for lease and connection identity; the journal alias is only for resume-key compatibility and never grants authority.
- Result artifacts use opaque task keys under an owner-owned `0700` directory and owner-only `0600` files. Only verified policy-released registered extraction outputs may be persisted.
- Partial collection checkpoints remain separate from journals and complete result artifacts. They bind task, target, endpoint, goal fingerprint, principal, environment, typed intent, capability manifest, source observation, and field/release policy fingerprints. They contain released rows only, mark output incomplete, record no unresolved operations, store route/cursor identity fingerprints, and strip query strings, fragments, and credentials from provenance routes.
- Resume revalidates exact target, endpoint, principal, environment, intent, capability binding, field/read/release policies, current route, and source observation before restoring rows. It reobserves before reconciling an uncertain action. A partial checkpoint never proves collection completeness by itself.
- Virtualized-list scroll checkpoints and same-URL next-button checkpoints are not written when the next cursor cannot be reconstructed safely. Resume must fail closed if current page identity or cursor differs from the checkpoint.
- Durable `RunStateStore` records are authoritative for status, cancellation, interventions, target fencing, pending effects, and terminal results. Process-local maps may retain disposable worker handles or in-memory result projections only.
- Writes are bounded, atomic, checksummed where applicable, and reject symlinked or non-owned storage paths. Eviction removes both complete artifacts and partial checkpoints for the evicted task.

## Verification

```bash
node --test test/mcp-task-journals.test.js test/runState.test.js
```

## Child DOX Index

No child DOX boundaries.
