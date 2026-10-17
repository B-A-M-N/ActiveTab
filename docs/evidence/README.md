# BrowserAct REA Evidence

These complete REA Evidence JSON records preserve the analyzed source digests, selected paths, graph facts, coverage, limitations, and unknowns cited by [the engineering plan](../engineering-plan.md). They are static observations of public source checkouts, not a BrowserAct SaaS run.

REA 6.5.0 analyzed the sources on 2026-10-16. The sandboxed worker pipe initially returned no child output; running the same local REA CLI through the host process path completed successfully. No BrowserAct API credential was configured or used.

| File | Evidence ID | Subject SHA-256 | Selected scope |
|---|---|---|---|
| `browseract-api-examples-v2-rea-evidence.json` | `ev_747c4cd6ebf06fc6f3ec4d3dbaed4808f5dfc74e12926a81c6b6bd5eea9d226b` | `58704118944b686981967917c32d32144bf6b7ec6c20cce426f313b5661471cb` | Five V2 JavaScript example files; nine relevant files left unselected. Application and semantic graphs are partial. |
| `browseract-api-examples-v2-run-task-trace.json` | `ev_1f7548a812dfc8a9c034c13d8c2a84a62a44023307985a38e5f8c50dfe7c2eab` | Parent Evidence above | Exact route `/v2/workflow/run-task`; matches two source locations. Partial source graph, 41 nodes and 40 edges in the trace. |
| `browseract-n8n-v3-rea-evidence.json` | `ev_9977605e24255ce1ca3fcd28875573174bb5181f39c71566e85bb491a43437ec` | `e6ed53cdd876c9d1aa6dc593a836aa9ec5427bb0aa48a5bcf6627d8d37109a6d` | Five V3 TypeScript files; eleven inventoried files left unselected. Application graph: 61 nodes / 82 edges, partial. Semantic graph: 2,069 nodes / 1,803 relations / 674 unknowns, partial. Request family: zero retained relations / six unknowns. |

The V3 client delegates HTTP to n8n's authenticated request helper. Its endpoint and task lifecycle details in the engineering plan also use direct inspection of the same pinned public source. The V2 route trace identifies example source locations; it does not establish a live server contract.
