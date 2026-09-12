# Implementation Red-Team Review — Project Memory CLI

Mode: implementation. Baseline: design v5 + review corrections. Revision under
review: initial MVP (all 32 tests passing, benchmarks executed).

## Primary Reviewer findings (recorded before independent reviewer output)

| ID | Priority | Claim attacked | Tentative issue |
| --- | --- | --- | --- |
| P-1 | medium | "Assemble retrieval against one SQLite read snapshot" | `assembleContext` issues multiple autocommit reads with no wrapping read transaction; a concurrent writer (second `pm` process) can commit between reads, so the packet is not one snapshot. View recheck covers files/HEAD but not memory generation/revisions. |
| P-2 | medium | "Do not inherit provider credentials, endpoints or remote defaults" (R1) | `zvecDiscover` spawns the worker with the full parent environment; if zvec reads provider env defaults, the worker inherits them. Should pass a sanitized environment. |
| P-3 | medium | Context deadline 2 s | zvec worker timeout is 10 s, so a slow worker can push a context request far past the documented 2 s deadline. Worker budget should be capped by the context deadline. |
| P-4 | low-med | Scope filters before ranking | `decisionsForScopePath` matches `scope_value = ''` for path/package/file kinds, so an empty scope value on a non-project kind would match every file query. Validation should require non-empty scope_value for non-project scope kinds. |
| P-5 | low | Cross-version line-coordinate comparison | `whyAt`/`decisionsForFile` compare requested current-view lines against anchor lines from a possibly different content version. Mitigated: hits are labeled `historical` via applicability; design allows returning the historical location. Watch for reviewer counterexamples. |
| P-6 | low | Binding observed = validated callback | `validateBinding` marks the binding observed before the import parse/ingest succeeds. The callback WAS observed; severity low. |
| P-7 | low | forget --decision preview | CLI preview path for `--decision` doesn't verify the decision exists before printing the preview. |
| P-8 | low | Arg parser | Flag values that begin with `--` cannot be expressed; repeated-flag parsing scans raw argv and could misread a flag value that itself looks like `--source-event`. |

Adjudication of these plus the independent Red Team and Simplifier findings
follows below after the independent passes complete.
