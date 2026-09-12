# Project Memory CLI — Implementation Status

Baseline: `outputs/project-memory-design.md` (v5) + accepted review corrections
(`outputs/project-memory-review.md`). This file is the resumption point: it records
verified facts, milestone state, and what remains unsupported.

## Stage 0 — Dependency contracts (VERIFIED 2026-09-12)

| Contract | Pinned / verified | Evidence |
| --- | --- | --- |
| Runtime | Node v26.3.1 (engine `>=22.18`), native TS type-stripping, no build step | `node --version`; `.ts` bin runs directly |
| SQLite | `node:sqlite` built-in, SQLite **3.53.4** (> 3.51.3 WAL-reset fix) | runtime probe |
| FTS5 | available, `snippet()` works | runtime probe |
| Foreign keys | per-connection `PRAGMA foreign_keys=ON` honored | runtime probe |
| WAL + synchronous=FULL | honored on local APFS | runtime probe |
| Backup | `node:sqlite` exports online `backup()`; `VACUUM INTO` also works | runtime probe |
| Git | 2.54.0 (Apple Git-157); accepts `--no-replace-objects --no-lazy-fetch` | `git --no-replace-objects --no-lazy-fetch version` → exit 0 |
| zvec-grep | npm `@zvec/zvec-grep@0.2.1` (exact pin) — matches design's pinned commit `d4e8a3ea…`: exports `createZvecGrep`, `info()`, `context({autoUpdate:false, rg:true,…})` | npm registry + raw source at pinned commit |
| Offline vectors | **BLOCKED as designed** — no public offline/no-download model option at 0.2.1. Retrieval uses lexical (`rg`) route + SQLite FTS only. | design [^25], confirmed against `src/engine/service/types.ts` |
| OS | macOS (darwin, APFS) is the single supported OS for this MVP | this machine |

## Milestones

| M | Scope (design stage) | Acceptance | State |
| --- | --- | --- | --- |
| M0 | Stage 0: pin contracts above | table above; `pm doctor` re-checks at runtime | **DONE** |
| M1 | Stage 1: CLI, registration, bounded generic JSONL importer, manual decisions, propose/confirm/supersede, exact anchors, FTS, context/why/search/inspect/history, export, forget (+ markers), doctor | synthetic import → confirm → why/context → restart → export/forget round-trip; replay idempotence; conflict records; forget dependency rules; supersession race constraints | **DONE** — 20/20 e2e tests pass (`test/cli.test.ts`) |
| M2 | Stage 2: zvec-joined context (lexical route only), identity checks, `pm index`, worker isolation, budgets, current-view recheck | no implicit index mutation; wrong-root/changed-identity rejection; missing zvec ⇒ typed degraded result; `--max-bytes` hard ceiling incl. insufficient-budget | **DONE** — real zvec worker verified (rg route, no index artifacts); budget tests pass |
| M3 | Stage 3: Claude Code adapter (transcript import + `capture setup` snippet + pending binding) | fixture: resume/fork lineage isolation; no cross-lineage approval; setup emits config, never writes host config | **DONE** — fork/unknown-ancestry/thinking-discard fixtures pass |
| M4 | Stage 4: Codex + Cursor adapters (fixture-gated, one at a time). MCP deferred. | each adapter passes its own fixtures; unsupported surfaces reported as partial | **DONE** (synthetic fixtures); MCP not built (per design: after CLI contract stabilizes) |
| M5 | Stage 5: backup/restore, purge, recovery drills, latency benchmark, token comparison | consistent backup; restore rotates generation + capture disabled; measured p95 lookups; honest labels for unmeasured targets | **DONE** — see `bench/RESULTS.md`; token/correctness comparison labeled UNMEASURED |

## Decisions taken (with rationale)

- **`node:sqlite` over better-sqlite3**: bundled 3.53.4 passes every stage-0 probe; zero
  native build; the design requires a pinned, verified build, not a specific package.
- **Vector retrieval disabled**: design blocks strict-offline vectors at zvec 0.2.1
  (no public offline/preflight contract). Context uses SQLite FTS5 + zvec `rg` lexical
  route. This is the design's documented fallback, not a deviation.
- **zvec is a hard npm dependency but a soft runtime dependency**: if the module or its
  index is missing, context degrades to FTS with a typed `degraded` reason.
- **MCP not implemented**: design stages it after the CLI contract is stable; the CLI
  contract stabilized only at the end of this MVP.

## Remaining limitations / unsupported

- Semantic (vector) retrieval: blocked upstream (offline enforcement), by design.
- MCP surface: not built (later scope per design).
- Advanced Git rename/diff remapping: not built; changed files return historical anchors.
- Codex/Cursor: import adapters against synthetic fixtures only; no live-host conformance
  (no real host sessions were captured — synthetic fixtures per instruction).
- Token/correctness comparison vs zvec-grep alone: **unmeasured** — requires paired live
  agent tasks; latency benchmarks were executed (see bench/RESULTS.md).
- Single OS: macOS. Linux/Windows admission primitives unverified.
