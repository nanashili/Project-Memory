# Benchmark results — 2026-09-12

Machine: macOS (darwin 27.0.0, APFS), Node v26.3.1, SQLite 3.53.4 (node:sqlite).
Fixture: git repo with 50 files, 200 imported events, 40 confirmed decisions.
Run: `npm run bench` (fresh isolated PM_HOME per run).

## Measured

| Path | p50 | p95 | mean | design target |
| --- | --- | --- | --- | --- |
| Warm exact lookup (`why`, library-level) | 0.1 ms | **0.2 ms** | 0.1 ms | p95 < 100 ms ✓ |
| Warm task packet (`context`, library-level) | 81.1 ms | **91.2 ms** | 81.5 ms | p95 < 750 ms ✓ |
| CLI `pm why` (per-process, incl. Node startup) | 193.0 ms | 205.4 ms | 193.3 ms | — |
| CLI `pm context --no-zvec` | 280.3 ms | 334.4 ms | 286.3 ms | — |
| CLI `pm context` with zvec lexical worker | 424.9 ms | 484.9 ms | 436.0 ms | — |
| Import of 200-event transcript (one transaction) | — | — | 209.9 ms | 250 ms capture deadline ✓ |

Warm task-packet time is dominated by hardened read-only git subprocess calls
(layout revalidation, HEAD, per-file status, bounded log); the SQLite portion is
sub-millisecond. CLI figures include Node startup and TypeScript type-stripping
per invocation.

## Unmeasured (labeled honestly)

- **Total workflow tokens vs zvec-grep alone** — requires paired live agent
  tasks with the same model/settings; the design's 30 %-fewer-tokens target is a
  hypothesis, not a result.
- **Task correctness comparison** — same requirement.
- **Cold-start model loading** — not applicable: vector retrieval is blocked
  upstream (no offline model contract at @zvec/zvec-grep 0.2.1).
