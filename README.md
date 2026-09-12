# Project Memory CLI (`pm`)

Local-first memory for one developer's projects: it stores coding-agent
conversations and decisions in SQLite, links every decision to exact code
versions and Git history, and serves compact, source-backed context back to any
coding agent through a CLI. Code discovery reuses the pinned
[@zvec/zvec-grep](https://github.com/zvec-ai/zvec-grep) public library
(lexical route).

Design baseline: `project-memory-design.md` v5 and its review (see
`docs/STATUS.md` for what is implemented, verified and still unsupported).

## Setup

Requirements: **Node ≥ 22.18** (uses built-in `node:sqlite` and native
TypeScript type-stripping; verified on Node 26), **git ≥ 2.42** (needs
`--no-lazy-fetch`), macOS (only verified OS).

```sh
npm install        # pins @zvec/zvec-grep@0.2.1
npm run typecheck
npm test           # full suite (~35 s)
npm run bench      # latency benchmark (see bench/RESULTS.md)
```

Run the CLI as `node src/cli.ts …` or link it: `npm link` → `pm …`.
Memory lives in `~/Library/Application Support/project-memory/` (override with
`PM_HOME`), one SQLite database per registered project, owner-only permissions.

## Workflow

```sh
cd /path/to/project
pm init                                   # register (capture stays off)
pm capture import --adapter generic --input transcript.jsonl
pm decisions add \
  --proposition "Use at most three retry attempts" \
  --rationale "upstream request allowance" \
  --scope-kind file --scope-value src/retry.ts \
  --source-event <E-id> --source-code src/retry.ts:40:58
pm why src/retry.ts:57                    # exact, version-checked answer
pm context --task "change retry behavior" --file src/retry.ts --max-bytes 8192
pm search "why retries are bounded"
pm inspect D-… --sources
pm history --file src/retry.ts            # decision anchors + git clues
pm export --output memory.jsonl
pm forget --session S-… --preview         # then --yes
pm backup --output snap.db / pm restore --input snap.db --yes
pm doctor
```

Agent-side (candidates only — confirmation is always the developer's CLI action):

```sh
pm decisions propose --input candidates.json --request-id <namespaced-id>
pm decisions confirm D-… --expected-revision 1
pm decisions supersede D-old --expected-revision 1 --with D-new --with-expected-revision 1
```

Adapters: `generic` (explicit JSONL), `claude-code`, `codex`, `cursor` — all
import-based. `pm capture setup <host>` prints a host config snippet and a
pending binding ID; it never edits host configuration.

## Guarantees (tested)

- **No implicit work on retrieval**: context never rebuilds indexes, downloads
  models, or sends embedding requests. Vector search is blocked upstream
  (no offline contract at zvec 0.2.1); retrieval is SQLite FTS5 + zvec's
  lexical `rg` route with `autoUpdate: false` in an owned, killable worker.
- **Authority is explicit**: agent proposals are candidates with idempotency
  receipts; only developer CLI actions confirm; evidence can't self-confirm.
- **Exact versioned anchors**: changed files return historical anchors, never a
  silently remapped "current" location. Applicability is derived per query.
- **Isolation**: one database per project; cross-project citation fails; a
  moved/replaced root fails identity checks until explicitly re-registered.
- **Forgetting is dependency-aware**: losing any source deletes dependent
  decisions; a surviving successor keeps only a non-content
  `predecessor-forgotten` marker; suppressions block replay; purge retires the
  project generation even after DB deletion.
- **Bounded output**: `--max-bytes` is a hard ceiling on the serialized packet;
  omissions are counted, and un-fittable mandatory metadata is a typed
  `insufficient-budget` failure.
- **Hardened Git evidence**: fixed read-only argument arrays, sanitized
  environment, `--no-replace-objects --no-lazy-fetch`, alternates rejected.

## Limitations

See `docs/STATUS.md` — notably: vector retrieval blocked upstream; MCP not yet
built; no rename remapping; host adapters verified against synthetic fixtures
only; token/correctness benefit vs zvec-grep alone is unmeasured; macOS only.
