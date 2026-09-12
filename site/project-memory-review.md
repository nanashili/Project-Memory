# Project Memory CLI — Architecture Review

## Verdict and evidence boundary

**Plan review converged; implementation and benefit remain unverified.** Eight complete independent Red Team and Simplifier rounds were completed. The final two rounds, 7 and 8, found no new critical, high or medium issue; the final independent first-principles attack found none either. Every recorded finding is adjudicated below. The initial proposal overreached at several dependency and lifecycle boundaries; the revised design removes unnecessary services and makes capture, authority, source identity and deletion claims narrower and testable.

The accompanying design is the current proposal. Earlier drafts are review baselines, not additional requirements. This appendix records decisions and planned verification. It does not assert that a database, CLI, agent adapter, test suite or benchmark exists.

Fixed requirements are a local tool for one developer, reuse of zvec-grep indexing, conversation and decision history linked to project material, quick file/line or conceptual retrieval, Git-history use, a CLI, token/context conservation, and first-wave consideration of Codex, Claude Code and Cursor across varied project types. Team sharing is later. Database choice, language, capture cadence, MCP timing and resolver complexity are provisional design choices.

Evidence consists of the supplied scope, public upstream source and primary documentation cited in the design. No private repository, agent transcript or live index was inspected. The zvec source snapshot is pinned in the design; host support is a research snapshot that still needs release-specific conformance before implementation.

## Independent primary findings

The primary issue list was completed before reading the independent Red Team and Simplifier findings. All counterexamples below are reasoned design cases, not runtime reproductions.

| ID / priority | Counterexample and adjudication | Correction and closing verification |
| --- | --- | --- |
| P1 / medium | **ACCEPTED.** An obsolete zvec CLI/JSON assumption fails or triggers indexing; host docs imply unsupported surface parity. | Use pinned public typed zvec interface and explicit no-refresh settings; host/version fixtures. Test missing index and unsupported host without side effects or false completeness. |
| P2 / medium | **ACCEPTED.** An approval in one fork is attached to a different conversational branch sharing a prefix. | Preserve exposed lineage, bind sources to the admitted branch, and label unknown ancestry. Replay/resume/fork fixtures. |
| P3 / medium | **ACCEPTED.** A file edit or branch switch mixes evidence from several workspace states. | One memory snapshot, named source digests/HEAD, final revalidation, one retry then changed-view. Deliberately mutate during assembly. |
| P4 / medium | **ACCEPTED.** A crash or nondeterministic repeated extraction duplicates candidates or skips a source range. | Remove separate automatic extraction initially; atomic agent-proposal request receipts and source checks. Crash at request commit/ack boundaries. |
| P5 / medium | **ACCEPTED.** Identical copied code is falsely declared the current home of an old decision. | Preserve immutable anchor; exact identity first, later mapping only with evidence; copies/splits abstain. Copy/split/branch fixtures. |
| P6 / medium | **ACCEPTED.** Redacted payload equality is reported as equality of the complete raw source. | Digest is explicitly for retained normalized content; source revision and coverage remain separate. Vary excluded source bytes with unchanged retained text. |
| P7 / medium | **ACCEPTED.** Purge then re-registration admits a delayed callback for the old project. | Random binding generation, no callback-created project, retained non-content suppression. Old callback and old-backup restore fixtures. |
| P8 / low | **ACCEPTED.** A new parser/attribution system duplicates existing indexing and Git provenance without a proved requirement. | Native Git, exact anchors and optional public imports; structural/semantic resolver work deferred. Baseline retrieval requires no parser plugin. |
| P9 / low | **ACCEPTED.** Supersede CLI example omits expected revisions required by the mutation contract. | Corrected example includes both revisions. CLI contract fixture must reject stale mutation. |
| P10 / medium | **ACCEPTED.** A returned code path is swapped to an outside symlink when only transcript paths use safe admission. | Apply descriptor/no-follow admission to current source reads as well. Race source replacement before snippet read. |
| P11 / low | **ACCEPTED.** Index path alone is mistaken for dependency identity across a rebuild. | Include roots, model/schema and index version; reject changed identity at emission. Replace index during query. |

P9–P11 arose during the primary pass on the complete rewrite and were corrected before its next independent round.

## Red Team round 1 adjudication

The Red Team examined correctness, privacy, isolation, recovery, operability and compatibility. Nine material gaps were accepted. The corrections below address the demonstrated gap; they do not automatically adopt every proposed mechanism from the reviewer.

| ID / priority | Concrete attack and decision | Final mechanism and closing verification |
| --- | --- | --- |
| R1 / high | **ACCEPTED.** A pre-existing remote-model index or global default sends task/source text despite a local-only policy. | First release allows an explicitly constructed local model only, rejects incompatible/unknown indexes and provisions model cache during setup. Verify no provider call with remote defaults, replaced index and missing model. |
| R2 / high | **ACCEPTED.** An asynchronous index job writes after purge or registration change; the original document blurred code-index and memory ownership. | No shared daemon/watchers or asynchronous background jobs. Own and reap synchronous maintenance workers; memory deletion explicitly excludes independently managed code indexes. No memory corpus in code index. Delay a worker across cancellation/purge/re-registration. |
| R3 / high | **ACCEPTED.** Transcript path replacement or a symlink ingests another project's/private file. | Approved source binding, safe no-follow traversal, regular-file descriptor and identity checks, bounded streaming. Test symlinks, FIFOs, replacement and remote/unapproved paths. |
| R4 / high | **ACCEPTED.** A thought or unknown text-bearing event becomes generic assistant content and enters FTS/export. | Closed retained event classes; discard hidden/internal/unknown fields. Feed Cursor thought and synthetic future fields; no retained text, FTS or export copy. |
| R5 / high | **ACCEPTED.** Identical-prefix file rotation makes an ordinal cursor skip or misattribute events while claiming completeness. | Per-adapter source/framing contract; uncertainty starts a gapped generation. Crash, rotation, truncation and concurrent writer fixtures. |
| R6 / medium | **ACCEPTED.** Opposing supersession writes validate outside one serialized transaction and create a cycle. | Immediate transaction, expected revisions, increasing creation sequence, one active successor and bounded integrity failure. Race opposing/two- and three-node writes; corrupt-chain fixture. |
| R7 / medium | **ACCEPTED.** Forget removes a critical source but other links keep a misleadingly supported confirmed decision active. | Any forgotten source dependency deletes the affected decision/revisions by default. Explicit retained replacement is detached and inactive until re-confirmed. Race each evidence deletion against confirmation/proposals. |
| R8 / medium | **ACCEPTED.** Automatic hook edits overwrite concurrent unrelated settings; uninstall removes a user-edited entry. | First slice emits setup snippets and never mutates shared host config. Automatic editing is a later separately gated feature. Verify setup has no host configuration writes. |
| R9 / medium | **ACCEPTED.** Shared daemon or wrong-root results leak context; unbounded dependency work defeats deadlines. | Direct owned worker, approved root/model/index identity, safe current-source reads, output/work limits and cancellation. Wrong-root/stale identity/huge stream and termination fixtures. |

The apparent requirement to delete zvec's existing code index was removed by an explicit ownership boundary, not by adding a second index lifecycle database. If a future decision-semantic corpus is introduced, it becomes controlled derived memory and needs its own deletion/resurrection tests.

## Simplifier round 1 adjudication

| ID / priority | Adjudication and evidence | Result and verification |
| --- | --- | --- |
| S1 / medium | **ACCEPTED.** The required CLI can perform the entire first workflow without MCP. | Stage MCP after JSON-domain fixtures. CLI-only import → confirm → context → export/forget must work. |
| S2 / high | **ACCEPTED.** A separate model rereading conversations adds tokens, retry state and privacy surface before value is measured. | Remove background/model extraction service; retain manual records and explicit proposals by the already-active coding agent. No new model call is needed for the first workflow. |
| S3 / medium | **ACCEPTED.** Persisted current applicability drifts when a branch changes. | Applicability derived at query time, with no cache initially. Change views without editing decision rows. |
| S4 / low | **ACCEPTED.** A second Git metadata cache has no demonstrated hot query. | Store typed OID/source locators and bounded excerpts; query Git lazily. Missing/present-object fixtures need no cache. |
| S5 / medium | **ACCEPTED.** Four remapping strategies and a mapping cache exceed the first file/line proof. | Exact immutable anchors first; Git mapping later; structural/semantic mapping deferred. Changed/renamed/split locations remain historical initially. |
| S6 / medium | **ACCEPTED, with narrower correction.** Avoid a registry service or duplicate mutable project state. A global multi-project DB is not required to achieve that simplification. | Keep one atomic root-to-database config and per-project files; separate database connections enforce default project scope. Verify unrelated roots, linked worktrees and deterministic per-project backup/deletion. |
| S7 / high | **ACCEPTED, with scope preserved.** A generic multi-host capture framework before one importer is unjustified. Dropping gap/lineage semantics would permit false completeness. | Implement importer then one adapter, then Codex/Cursor. Unsupported fork/compaction behavior is explicit partial coverage until fixtures pass. |
| S8 / medium | **ACCEPTED.** Arbitrary decision graph traversal is unnecessary. | Typed source links and a constrained direct supersession pointer replace generic edges. Verify active/history results and concurrent supersession. |
| S9 / low | **REJECTED as a document-scope change.** The fixed request explicitly asks how the tool works across varied project types; the table describes limits without requiring plugins. | Retain the discussion; stage evaluation from three fixtures to representative workloads. The same exact anchor works on TypeScript, YAML and unsupported extensions without parser plugins. |
| S10 / medium | **ACCEPTED, with durability gate retained.** State a clear controlled-local deletion guarantee before wider lifecycle machinery. | Simplify ownership and deletion language; backup/restore/migration drills remain required before durable release because confirmed rationale is authoritative data. |

## Round 2 adjudication

Round 2 repeated the full independent correctness and simplification passes over the rewrite. The Red Team accepted closure of its nine prior cases and found two further medium issues. The primary full-plan pass on the next rewrite found no additional material issue.

| ID / priority | Adjudication | Correction or evidence for rejection |
| --- | --- | --- |
| R2-1 / medium | **ACCEPTED.** A host can reuse session/event IDs across conversation forks. | Add opaque namespaced lineage to event uniqueness, source citations and proposal receipts. Unknown lineage is isolated/unverified. The closing fixture forbids incorrect approval attribution across forks, while still allowing explicitly confirmed project-scoped decisions to be shared across agents as required. |
| R2-2 / medium | **ACCEPTED.** A deleted/incomplete cache can make local model preparation download during context. | Pre-admit model completeness before any loader; require a verified offline runtime or enforced offline environment. Source verification found no public offline/preflight option, so strict offline vectors remain blocked and FTS available until resolved. Test missing/replaced cache with network/write instrumentation. |
| S2-1 / medium | **ACCEPTED as clarification.** A discovery registry must not independently authorize a root-to-memory association. | Database project identity/approved roots/lifecycle are explicitly authoritative; registry only locates a candidate database. Root move requires explicit rebind. |
| S2-2 / low | **REJECTED.** Removing the worker while promising a hard deadline lacks an equivalent cancellation mechanism. | Public typed `context` options have no cancellation signal. A JavaScript timeout does not terminate native work; the suggested CLI subprocess is itself a process boundary and loses typed output. Retain one owned worker only for dependency work, not exact SQL requests or a daemon. |
| S2-3 / medium | **ACCEPTED as retention clarification.** Captured visible text could be mistaken for indefinitely expanding full history. | Distinguish required decision spans and optional broader evidence. State until-explicit-delete retention and quota-stop behavior, shared-event deletion semantics, and FTS/inspect consistency. Do not add automatic expiry that weakens decisions. |
| S2-4 / low | **ACCEPTED.** Unknown tokenizer/model makes an exact universal token limit misleading. | Add authoritative serialized UTF-8 byte ceiling and `--max-bytes`; token budget is an explicit target/estimate unless a pinned tokenizer is supplied. |
| S2-5 / medium | **ACCEPTED as sequencing.** Native callback bindings need not exist before native adapters. | Explicit imports use project lifecycle/source identity; native random adapter binding arrives with the first writer. Preserve the project generation needed for a concurrent import/purge. |
| S2-6 / medium | **REJECTED as removal of lineage identity; ACCEPTED metadata simplification.** Removing lineage from the durable core would reintroduce R2-1's concrete fork collision. | Require only an opaque namespaced lineage key; provider-specific fork/subagent/compaction details remain allowlisted metadata. No generic provider graph is added. |
| S2-7 / low | **REJECTED as already satisfied.** The counterexample assumes MCP before stable CLI/one adapter. | Stages 1–3 are CLI-only and MCP is an optional stage-4 transport over the same domain contract. Naming the later three-tool surface does not implement it early. |
| S2-8 / low | **ACCEPTED with patch provenance retained.** A version string does not prove capabilities; a stress test alone also cannot prove a known race fix is present. | Require maintained fix provenance plus FTS5/foreign-key/WAL/backup probes on each OS. Future fixed versions/backports qualify; no literal single-version equality rule. |

The S2-6 recommendation is split into two concrete claims because removing the invariant and simplifying optional metadata have different outcomes. There are no undecided findings in this log. Finding severity describes the original claimed gap; implementation work remains separate.

## Round 3 adjudication

The third full Red Team pass found no new critical, high or medium issue. Its attacks covered source lineage, offline vectors, dependency scope/cancellation, file admission, hidden/hostile evidence, SQLite/deletion/recovery, Git/current views and output budgets. Simplifier feedback still identified a redundant continuity term, so the full artifact was revised again and the consecutive-clean count restarted conservatively.

| ID / priority | Adjudication | Final correction or counterevidence |
| --- | --- | --- |
| S3-1 / medium | **ACCEPTED.** Capture epoch duplicates continuity already represented by source lineage. | Remove the extra term/state. Project lifecycle, opaque source lineage and native binding each have one distinct responsibility. |
| S3-2 / low | **ACCEPTED.** A generic budget flag is less clear than one named hard unit. | `--max-bytes` is the only hard packet limit; optional `--token-target` is advisory. Defaults and the CLI example use bytes. |
| S3-3 / low | **ACCEPTED.** Generic serialization of provider metadata could bypass named content policies. | Limit metadata to allowlisted scalar IDs/coverage; FTS/default export select named content fields. Provider text must pass retained-class admission separately. |
| S3-4 / low | **ACCEPTED as clarification.** Receipt wording could imply an unnecessary second workflow. | A bounded proposal-application record is the idempotency receipt; there is no queue or separate status lifecycle. Keep source suppression separate. |
| S3-5 / medium | **REJECTED.** The suggested mutable retention class duplicates an existing authoritative relation and does not fix the stated quota behavior. | Decision-to-source foreign-key links already determine whether evidence is required. Both broader and required evidence deliberately use until-explicit-delete retention. Quota stopping is required behavior, not a defect; no expiry policy needs another flag. The final text makes this derivation explicit. |
| S3-6 / low | **ACCEPTED.** Generated setup must not imply a working installed adapter. | Store pending binding; distinguish generated from a validated matching callback observed. Neither proves full capture. Purge invalidates pending and observed bindings, closing the stale generated-snippet case too. |

## Round 4 disposition

The fourth complete Red Team and Simplifier passes found no new critical, high or medium issue. The full design remained unchanged for the next pass. The Simplifier retained two low implementation preferences, both adjudicated **ACCEPTED with no design change needed**: physical tables may be coalesced if the logical invariants hold; advisory token estimates must not become a second authority over the hard byte ceiling. The design already states both boundaries. Neither compromises correctness, isolation, compatibility, privacy or recoverability.

## Round 5 adjudication

The fifth complete Simplifier pass was clean. The Red Team found one additional medium issue, so the earlier clean round did not establish convergence. The complete design was revised to v4 and the consecutive-clean count restarted.

| ID / priority | Adjudication and evidence | Final correction and closing verification |
| --- | --- | --- |
| R5-1 / medium | **ACCEPTED.** A repository can read another object's store through Git alternates even when commands are read-only and their checkout root is correct. The Git repository-layout documentation confirms file and environment alternate mechanisms. | Admit canonical Git/common/object-store identity; initially reject alternates and unapproved redirections instead of adding alternate-store federation. Recheck layout around evidence reads/retention. An unsupported enforcement path disables Git enrichment. Fixtures cover another project's unique alternate blob, metadata mutation, environment overrides and valid linked worktrees. |

The correction also requires documented replacement-object and lazy-fetch controls. Replacement refs can change interpreted evidence, while missing promisor objects can trigger network activity during an apparent read. Fixed argument-array commands, sanitized Git environment and capability-gated flags must be tested with replacement refs and instrumented missing-object fixtures. These additions are requirements based on public documentation; no runtime test was executed.

The earlier primary first-principles pass did not identify the alternate-store case. That limited result is preserved rather than rewritten as if it had. A new primary pass reviewed the entire v4 proposal before the next independent reviewer outputs; no further material finding emerged. At this point, convergence still depended on subsequent complete rounds.

## Round 6 adjudication

Round 6 identified one material deletion-integrity issue and one lifecycle-state simplification. Both are accepted in the complete v5 rewrite; the consecutive-clean count restarts.

| ID / priority | Adjudication and evidence | Final correction and closing verification |
| --- | --- | --- |
| R6-1 / medium | **ACCEPTED.** Forgetting source S1 can remove predecessor D1 while independently sourced confirmed D2 still points to it. An unspecified foreign-key policy could reject deletion, cascade unrelated guidance or mistake deliberate forgetting for corruption. | The forget transaction erases D1 content and retains only a non-content terminal identity marker when D2 needs it. D2 reports a forgotten predecessor and remains active only under its own source/confirmation checks. Markers cannot be guidance or new targets. Test forgetting either/both sources, replay, foreign-key integrity and genuine missing targets. |
| S6-1 / medium | **ACCEPTED.** Project lifecycle generation and native capture generation duplicate the retired-writer boundary and could drift. | Use one opaque `project_generation` for imports, bindings, receipts and writer checks; lifecycle is a status. Keep source lineage/event/request identities separate. Purge/re-registration/restore and selective-forget fixtures verify the unified contract. |

The correction does not add a general decision graph or retain forgotten rationale. A marker contains only the opaque referenced identity, creation sequence and intentional-forgetting state; earlier-chain links are removed. Full purge removes it. The primary complete v5 pass found no further material issue before the next independent results.

## Round 7 disposition

Both independent reviewers completed clean full passes over v5: no new critical, high or medium defect, and no material requirement-preserving simplification. The correctness pass re-attacked the combined capture, scope, source identity, confirmation, deletion, recovery, dependency and budget boundaries. The Simplifier confirmed that the single project generation and terminal non-content predecessor marker preserve distinct necessary invariants. No design change followed this round.

## Round 8 disposition and final attack

Both independent reviewers completed a second consecutive clean full pass over unchanged v5. The Red Team considered combinations across restore/purge/generations, deletion markers/backups, source lineage/injected evidence, zvec/Git/current-view checks, offline behavior/storage pressure and SQLite/packet limits. The Simplifier found no additional material reduction. Its optional terminology preference is **ACCEPTED with no design change required**: “retired random generations” refers to the single random `project_generation` already defined, not another state variable.

The final independent primary attack then started from false authority, loss of the only evidence copy, forgetting across time, plausible but wrongly attributed code, dependency side effects during reads, component removal and misleading token savings. Each attack encountered a specific mechanism, conservative fallback or explicit unsupported boundary in the final plan. No new critical, high or medium finding emerged. These were reasoned attacks; no runtime reproduction or benchmark was run.

## Invariants and enforcement map

| Material invariant | Enforcement location | Failure/operating signal | Required acceptance evidence |
| --- | --- | --- | --- |
| No implicit project join | Registration, connection selection, source admission and result validation | Wrong/unassigned project, rejected root | Two unrelated roots plus linked worktrees and replacement root |
| Capture is idempotent and honestly bounded | Unique event identity, atomic cursor/FTS commit, explicit covered ranges | Duplicate/conflict/gap counters | Replay, crash-after-commit, rotation and unsupported framing |
| Evidence cannot self-confirm | Candidate-only agent endpoint; separate developer action and host tool policy | Candidate/authority mismatch | Forged approval and same-user trust-boundary demonstration |
| Current locations refer to checked content | Immutable anchor and retrieval digest/HEAD checks | Historical/ambiguous/changed-view | Dirty edit, copy, split, rename and branch switch |
| Git evidence stays within admitted local stores | Canonical common/object-store admission, rejected alternates, sanitized environment, replacement/lazy-fetch controls | Incomplete history or unsupported layout | External and changed alternates, replacement refs, missing promisor object and approved linked worktree |
| Lifecycle state cannot be bypassed by rank | SQL/source-generation filters before ranking and final revalidation | Deleted/stale/conflicting count | Forget/supersede while retrieving |
| Forget does not weaken or resurrect guidance | Source dependency set, immediate transaction, suppression/generation | Removed/detached decisions; rejected old callback | Selective evidence deletion against proposals/confirmation/replay |
| Forgetting history does not break independent guidance | Transactional terminal marker for a forgotten referenced predecessor | Visible forgotten-predecessor gap; integrity error for unexplained absence | Delete either/both independently sourced predecessor and successor, replay, and genuine corruption |
| Read context does not refresh indexes or send embeddings remotely | Pinned zvec adapter, explicit local model, no auto-update, preflight/worker boundary | Incomplete semantic coverage | Remote/unknown/replaced index, empty model cache, no provider calls |
| Resource failure cannot advance evidence cursor | Admission caps, short transactions, deadline and owned worker | Capacity/delay/cancelled status | Oversized input, storage fault, huge result and child termination |
| Durable memory can be recovered without silently reverting new data | Schema checks, consistent backup, disabled-on-restore capture | Schema/restore retention boundary | Interrupted backup/migration/restore and mixed binary versions |
| Fewer tokens still means useful answers | Paired task evaluation, source/quality and total-token accounting | Precision, attribution, abstention, latency and cost report | Same task/model/settings against ordinary and zvec-only baselines |

Enforcement in this table is a requirement for future code. The referenced tests are not yet implemented. Public documentation establishes dependency behavior, not fulfillment of these product invariants.

## Review rounds and remaining gates

Rounds 1 and 2 produced material findings. Round 3 was clean for the Red Team, but accepted Simplifier feedback triggered another full revision. Round 4 was clean; rounds 5 and 6 found additional material cases and each restarted the clean count. Rounds 7 and 8 were complete consecutive clean independent passes on v5. The final primary attack was also clean. No finding remains undecided or unresolved at medium severity or above in the revised plan; the external/runtime gates below remain unverified.

The rewrite removes shared daemons, automatic host configuration writes, background extraction, duplicate continuity/retention state and generic graph/remapping machinery. It preserves one local authoritative database per project, immutable evidence anchors, explicit decision authority, bounded retrieval and recovery requirements backed by planned acceptance tests. The convergence verdict applies to this documented scope only.

The runtime package and supported host/OS versions must be selected and tested in stage 0. Safe file-open primitives, hard worker limits, local model provisioning and the packaged SQLite binding are implementation gates. Any unsupported mechanism must remain a declared limitation or block that feature; it must not be replaced with an undocumented guarantee.

The core architecture does not depend on team synchronization, browser recording, semantic remapping or a decision-vector corpus. Those remain later scope and were not reviewed as implemented systems. No production rollout, data migration or rollback was executed because this work is a design discussion only.
