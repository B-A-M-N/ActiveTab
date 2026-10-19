# Response Inspection Resource Benchmark

Run `ACTIVETAB_CHROME_DISPLAY=secondary npm run benchmark:response-inspection` to place owned headed Chrome on the currently mapped HDMI-1 secondary display. The script starts a loopback-only fixture server, then closes Chrome and removes the temporary browser profile.

It measures selected-response acquisition, parsing, Markdown decomposition/indexing, wall time, per-case Node CPU time, and process RSS for ordinary JSON, a response close to the configured CDP per-resource buffer, high-token JSON, deeply nested JSON, high-line text, and a response above the inspector's decoded-size limit. It also records a cancellation attempt against a completed response. Node RSS is sampled every 25 ms and owned Chrome process-tree RSS every 500 ms; brief peaks can fall between samples.

Chrome returns `Network.getResponseBody` as one protocol result. The benchmark does not treat paging as an acquisition bound, and it does not claim the sampled RSS captures sub-25 ms peaks. Cancellation stops ActiveTab from waiting for a body response but cannot cancel Chrome's in-flight CDP command.

Record the command date, Node version, Chrome version, display mode, and JSON output when reporting measurements. Results are machine-specific and should not be compared across runs without matching those conditions.

## HDMI-1 measurement, 2026-10-19

Run conditions: Node.js 22.22.3, Chrome 150.0.7871.114, headed owned Chrome, HDMI-1 physical origin x=2880 (`screenX=1440`, device scale 2). Baseline-to-peak RSS was 67,919,872→139,526,144 B for Node and 1,219,837,952→1,461,837,824 B for the owned Chrome process tree. The Chrome RSS peak is sampled every 500 ms. Node CPU is cumulative process CPU time per case; it includes local harness work and is not a pure inspector profile.

| Case | Bytes | Result | Inspect wall | Node CPU user+system |
|---|---:|---|---:|---:|
| JSON | 65,536 | included | 213 ms | 219 ms |
| JSON | 262,144 | included | 486 ms | 232 ms |
| Near CDP buffer | 481,280 | included | 230 ms | 348 ms |
| 90k JSON scalar tokens | 180,013 | included | 1,262 ms | 2,285 ms |
| JSON depth 96 | 193 | `json_depth_limit` | 7 ms | 165 ms |
| 20,001 text lines | 40,002 | `body_line_limit` | 29 ms | 60 ms |
| Known decoded-size overage | 1,126,400 | `reported_decoded_body_bytes_limit`; body not acquired | 2 ms | 53 ms |

The completed-response cancellation attempt returned `cancelled` in the acquisition phase. The largest included case expanded to 964,119 bytes of Markdown; paging returned the requested 1,024-byte view while retaining indexed access to the full projection. This is a single machine-specific measurement and does not establish a before/after system-wide performance improvement.
