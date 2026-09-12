import type { DatabaseSync } from "node:sqlite";
import type { Project } from "./project.ts";
import { nextSeq } from "./db.ts";
import { invalid, newId, nowIso, sha256Hex, staleRevision, truncateUtf8, LIMITS } from "./util.ts";
import { anchorForFile, type CodeAnchor } from "./anchors.ts";

export type ScopeKind = "project" | "package" | "path" | "file" | "range" | "revision";
export type Origin = "developer" | "assistant" | "git" | "import";
export type Authority = "candidate" | "confirmed" | "rejected" | "superseded";

export type EventSourceInput = { kind: "event"; eventId: string; spanStart?: number; spanEnd?: number };
export type CodeSourceInput = { kind: "code"; file: string; lineStart: number; lineEnd: number };
export type ManualSourceInput = { kind: "manual"; note: string };
export type SourceInput = EventSourceInput | CodeSourceInput | ManualSourceInput;

export type DecisionInput = {
  proposition: string;
  rationale?: string;
  alternatives?: string;
  constraintsNote?: string;
  scopeKind: ScopeKind;
  scopeValue?: string;
  sources: SourceInput[];
};

export type DecisionRow = {
  id: string;
  current_revision_id: string | null;
  created_at: string;
};

export type RevisionRow = {
  id: string;
  seq: number;
  decision_id: string;
  rev: number;
  authority: Authority;
  origin: Origin;
  proposition: string | null;
  rationale: string | null;
  alternatives: string | null;
  constraints_note: string | null;
  scope_kind: ScopeKind;
  scope_value: string;
  supersedes_revision_id: string | null;
  forgotten: number;
  project_generation: string;
  created_at: string;
};

function validateAndResolveSources(
  project: Project,
  sources: SourceInput[],
): { insertRows: (db: DatabaseSync, revisionId: string) => void } {
  if (sources.length === 0) throw invalid("a decision needs at least one source");
  const db = project.db;
  const resolved: Array<Record<string, unknown>> = [];
  for (const s of sources) {
    if (s.kind === "event") {
      const ev = db
        .prepare("SELECT id, session_id, lineage, content FROM events WHERE id = ?")
        .get(s.eventId) as { id: string; session_id: string; lineage: string; content: string } | undefined;
      if (!ev) throw invalid(`cited event does not exist in this project: ${s.eventId}`);
      const lines = ev.content.split("\n");
      const start = s.spanStart ?? 1;
      const end = Math.min(s.spanEnd ?? lines.length, lines.length);
      if (start < 1 || end < start) throw invalid(`invalid span for event ${s.eventId}`);
      const excerptRaw = lines.slice(start - 1, end).join("\n");
      const [excerpt] = truncateUtf8(excerptRaw, LIMITS.maxExcerptBytes);
      resolved.push({
        kind: "event",
        event_id: ev.id,
        lineage: ev.lineage,
        span_start: start,
        span_end: end,
        excerpt,
        snippet_hash: sha256Hex(excerpt),
      });
    } else if (s.kind === "code") {
      const anchor: CodeAnchor = anchorForFile(project, s.file, s.lineStart, s.lineEnd);
      resolved.push({
        kind: "code",
        path: anchor.path,
        commit_oid: anchor.commitOid ?? null,
        blob_oid: anchor.blobOid ?? null,
        content_digest: anchor.contentDigest,
        line_start: anchor.lineStart,
        line_end: anchor.lineEnd,
        encoding: "utf-8",
        object_format: anchor.objectFormat ?? null,
        worktree: anchor.worktree ?? null,
        excerpt: anchor.excerpt,
        snippet_hash: sha256Hex(anchor.excerpt),
      });
    } else {
      const [excerpt] = truncateUtf8(s.note, LIMITS.maxExcerptBytes);
      resolved.push({ kind: "manual", excerpt, snippet_hash: sha256Hex(excerpt) });
    }
  }
  return {
    insertRows(dbi: DatabaseSync, revisionId: string) {
      const ins = dbi.prepare(
        `INSERT INTO decision_sources(id, revision_id, kind, event_id, lineage, span_start, span_end,
           path, commit_oid, blob_oid, content_digest, line_start, line_end, encoding, object_format, worktree,
           git_ref_note, excerpt, snippet_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of resolved) {
        ins.run(
          newId("SRC"),
          revisionId,
          r.kind as string,
          (r.event_id as string) ?? null,
          (r.lineage as string) ?? null,
          (r.span_start as number) ?? null,
          (r.span_end as number) ?? null,
          (r.path as string) ?? null,
          (r.commit_oid as string) ?? null,
          (r.blob_oid as string) ?? null,
          (r.content_digest as string) ?? null,
          (r.line_start as number) ?? null,
          (r.line_end as number) ?? null,
          (r.encoding as string) ?? "utf-8",
          (r.object_format as string) ?? null,
          (r.worktree as string) ?? null,
          null,
          (r.excerpt as string) ?? null,
          (r.snippet_hash as string) ?? null,
          nowIso(),
        );
      }
    },
  };
}

function insertRevision(
  project: Project,
  decisionId: string,
  rev: number,
  authority: Authority,
  origin: Origin,
  input: DecisionInput,
  supersedesRevisionId: string | null,
  insertSources: (db: DatabaseSync, revisionId: string) => void,
): string {
  const db = project.db;
  const revisionId = newId("R");
  db.prepare(
    `INSERT INTO decision_revisions(id, seq, decision_id, rev, authority, origin, proposition, rationale,
       alternatives, constraints_note, scope_kind, scope_value, supersedes_revision_id, forgotten, project_generation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    revisionId,
    nextSeq(db),
    decisionId,
    rev,
    authority,
    origin,
    input.proposition,
    input.rationale ?? null,
    input.alternatives ?? null,
    input.constraintsNote ?? null,
    input.scopeKind,
    input.scopeValue ?? "",
    supersedesRevisionId,
    project.identity.generation,
    nowIso(),
  );
  insertSources(db, revisionId);
  db.prepare("INSERT INTO decision_fts(revision_id, proposition, rationale) VALUES (?, ?, ?)").run(
    revisionId,
    input.proposition,
    input.rationale ?? "",
  );
  return revisionId;
}

/** Developer-authored decision: confirmed immediately (their CLI action IS confirmation). */
export function addDecision(project: Project, input: DecisionInput, origin: Origin = "developer"): {
  decisionId: string;
  revisionId: string;
} {
  const db = project.db;
  const authority: Authority = origin === "developer" ? "confirmed" : "candidate";
  db.exec("BEGIN IMMEDIATE");
  try {
    const { insertRows } = validateAndResolveSources(project, input.sources);
    const decisionId = newId("D");
    db.prepare("INSERT INTO decisions(id, current_revision_id, created_at) VALUES (?, NULL, ?)").run(
      decisionId,
      nowIso(),
    );
    const revisionId = insertRevision(project, decisionId, 1, authority, origin, input, null, insertRows);
    db.prepare("UPDATE decisions SET current_revision_id = ? WHERE id = ?").run(revisionId, decisionId);
    db.exec("COMMIT");
    return { decisionId, revisionId };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export type ProposalResult = {
  requestId: string;
  status: "applied" | "replayed-noop";
  decisionIds: string[];
};

/**
 * Agent-proposed candidates with an idempotency receipt. Retrying the same
 * request ID + payload is a no-op; the same ID with a different payload is an
 * error. Proposals can NEVER be confirmed by this path.
 */
export function proposeDecisions(
  project: Project,
  requestId: string,
  proposals: DecisionInput[],
): ProposalResult {
  if (!requestId) throw invalid("proposal requires a request id");
  if (proposals.length === 0) throw invalid("no proposals supplied");
  const db = project.db;
  const payloadDigest = sha256Hex(JSON.stringify(proposals));
  db.exec("BEGIN IMMEDIATE");
  try {
    const gen = db.prepare("SELECT value FROM meta WHERE key = 'project_generation'").get() as {
      value: string;
    };
    if (gen.value !== project.identity.generation) throw invalid("project generation changed");
    const receipt = db
      .prepare("SELECT payload_digest, decision_ids FROM proposal_receipts WHERE request_id = ?")
      .get(requestId) as { payload_digest: string; decision_ids: string } | undefined;
    if (receipt) {
      if (receipt.payload_digest === payloadDigest) {
        db.exec("COMMIT");
        return { requestId, status: "replayed-noop", decisionIds: JSON.parse(receipt.decision_ids) };
      }
      throw invalid(`request id ${requestId} was already used with a different payload`);
    }
    const decisionIds: string[] = [];
    for (const input of proposals) {
      const { insertRows } = validateAndResolveSources(project, input.sources);
      const decisionId = newId("D");
      db.prepare("INSERT INTO decisions(id, current_revision_id, created_at) VALUES (?, NULL, ?)").run(
        decisionId,
        nowIso(),
      );
      const revisionId = insertRevision(project, decisionId, 1, "candidate", "assistant", input, null, insertRows);
      db.prepare("UPDATE decisions SET current_revision_id = ? WHERE id = ?").run(revisionId, decisionId);
      decisionIds.push(decisionId);
    }
    db.prepare(
      "INSERT INTO proposal_receipts(request_id, project_generation, payload_digest, decision_ids, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(requestId, project.identity.generation, payloadDigest, JSON.stringify(decisionIds), nowIso());
    db.exec("COMMIT");
    return { requestId, status: "applied", decisionIds };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getCurrentRevision(db: DatabaseSync, decisionId: string): RevisionRow {
  const d = db.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId) as DecisionRow | undefined;
  if (!d) throw invalid(`unknown decision: ${decisionId}`);
  if (!d.current_revision_id) throw invalid(`decision ${decisionId} has no active revision`);
  const r = db.prepare("SELECT * FROM decision_revisions WHERE id = ?").get(d.current_revision_id) as
    | RevisionRow
    | undefined;
  if (!r) throw invalid(`decision ${decisionId} current revision missing (integrity error)`);
  return r;
}

/** Developer confirmation of a candidate revision; requires expected revision. */
export function confirmDecision(project: Project, decisionId: string, expectedRev: number): RevisionRow {
  const db = project.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const cur = getCurrentRevision(db, decisionId);
    if (cur.rev !== expectedRev) {
      throw staleRevision(`expected revision ${expectedRev}, current is ${cur.rev}`);
    }
    if (cur.forgotten) throw invalid("a forgotten marker cannot be confirmed");
    if (cur.authority === "confirmed") {
      db.exec("COMMIT");
      return cur;
    }
    if (cur.authority === "superseded") throw invalid("a superseded revision cannot be confirmed");
    // Source existence recheck: confirmation cannot restore deleted sources.
    const sources = db
      .prepare("SELECT event_id FROM decision_sources WHERE revision_id = ? AND kind = 'event'")
      .all(cur.id) as { event_id: string }[];
    for (const s of sources) {
      const ev = db.prepare("SELECT 1 FROM events WHERE id = ?").get(s.event_id);
      if (!ev) throw invalid(`source event ${s.event_id} no longer exists; cannot confirm`);
    }
    db.prepare("UPDATE decision_revisions SET authority = 'confirmed' WHERE id = ?").run(cur.id);
    db.exec("COMMIT");
    return { ...cur, authority: "confirmed" };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function rejectDecision(project: Project, decisionId: string, expectedRev: number): void {
  const db = project.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const cur = getCurrentRevision(db, decisionId);
    if (cur.rev !== expectedRev) throw staleRevision(`expected revision ${expectedRev}, current is ${cur.rev}`);
    db.prepare("UPDATE decision_revisions SET authority = 'rejected' WHERE id = ?").run(cur.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Supersession: a narrow reference from a newly confirmed revision of the
 * successor decision to the current revision of the superseded decision.
 * Serialized immediate transaction; expected revisions on both sides;
 * increasing creation sequence; one active successor per superseded revision.
 */
export function supersedeDecision(
  project: Project,
  oldDecisionId: string,
  oldExpectedRev: number,
  newDecisionId: string,
  newExpectedRev: number,
): { supersededRevisionId: string; successorRevisionId: string } {
  const db = project.db;
  if (oldDecisionId === newDecisionId) throw invalid("a decision cannot supersede itself");
  db.exec("BEGIN IMMEDIATE");
  try {
    const oldCur = getCurrentRevision(db, oldDecisionId);
    const newCur = getCurrentRevision(db, newDecisionId);
    if (oldCur.rev !== oldExpectedRev) throw staleRevision(`superseded: expected rev ${oldExpectedRev}, current ${oldCur.rev}`);
    if (newCur.rev !== newExpectedRev) throw staleRevision(`successor: expected rev ${newExpectedRev}, current ${newCur.rev}`);
    if (oldCur.forgotten) throw invalid("a forgotten marker cannot be a supersession target");
    if (newCur.forgotten) throw invalid("a forgotten marker cannot supersede");
    if (newCur.authority !== "confirmed") {
      throw invalid("only a confirmed revision can supersede (confirm the successor first)");
    }
    if (oldCur.authority === "superseded") throw invalid("target revision is already superseded");
    // Revisions are immutable: always create a fresh successor revision that
    // carries the supersession pointer. Its seq is the new maximum, so the
    // pointer always moves forward in creation sequence — cycles cannot form.
    const successorRevisionId = newId("R");
    db.prepare(
      `INSERT INTO decision_revisions(id, seq, decision_id, rev, authority, origin, proposition, rationale,
         alternatives, constraints_note, scope_kind, scope_value, supersedes_revision_id, forgotten, project_generation, created_at)
       VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      successorRevisionId,
      nextSeq(db),
      newDecisionId,
      newCur.rev + 1,
      newCur.origin,
      newCur.proposition,
      newCur.rationale ?? null,
      newCur.alternatives ?? null,
      newCur.constraints_note ?? null,
      newCur.scope_kind,
      newCur.scope_value,
      oldCur.id,
      project.identity.generation,
      nowIso(),
    );
    // carry sources forward (the source-dependency set is preserved)
    db.prepare(
      `INSERT INTO decision_sources(id, revision_id, kind, event_id, lineage, span_start, span_end, path, commit_oid,
         blob_oid, content_digest, line_start, line_end, encoding, object_format, worktree, git_ref_note, excerpt, snippet_hash, created_at)
       SELECT 'SRC-' || lower(hex(randomblob(16))), ?, kind, event_id, lineage, span_start, span_end, path, commit_oid,
         blob_oid, content_digest, line_start, line_end, encoding, object_format, worktree, git_ref_note, excerpt, snippet_hash, created_at
       FROM decision_sources WHERE revision_id = ?`,
    ).run(successorRevisionId, newCur.id);
    db.prepare("INSERT INTO decision_fts(revision_id, proposition, rationale) VALUES (?, ?, ?)").run(
      successorRevisionId,
      newCur.proposition,
      newCur.rationale ?? "",
    );
    const upd = db
      .prepare("UPDATE decisions SET current_revision_id = ? WHERE id = ? AND current_revision_id = ?")
      .run(successorRevisionId, newDecisionId, newCur.id);
    if (Number(upd.changes) !== 1) throw staleRevision("concurrent revision change on successor");
    db.prepare("UPDATE decision_revisions SET authority = 'superseded' WHERE id = ?").run(oldCur.id);
    db.exec("COMMIT");
    return { supersededRevisionId: oldCur.id, successorRevisionId };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Edit: creates an unconfirmed revision (must be re-confirmed explicitly). */
export function reviseDecision(
  project: Project,
  decisionId: string,
  expectedRev: number,
  changes: Partial<Pick<DecisionInput, "proposition" | "rationale" | "alternatives" | "constraintsNote" | "scopeKind" | "scopeValue">>,
): { revisionId: string; rev: number } {
  const db = project.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const cur = getCurrentRevision(db, decisionId);
    if (cur.rev !== expectedRev) throw staleRevision(`expected revision ${expectedRev}, current is ${cur.rev}`);
    if (cur.forgotten) throw invalid("a forgotten marker cannot be edited");
    const input: DecisionInput = {
      proposition: changes.proposition ?? cur.proposition!,
      rationale: changes.rationale ?? cur.rationale ?? undefined,
      alternatives: changes.alternatives ?? cur.alternatives ?? undefined,
      constraintsNote: changes.constraintsNote ?? cur.constraints_note ?? undefined,
      scopeKind: changes.scopeKind ?? cur.scope_kind,
      scopeValue: changes.scopeValue ?? cur.scope_value,
      sources: [],
    };
    const revisionId = newId("R");
    db.prepare(
      `INSERT INTO decision_revisions(id, seq, decision_id, rev, authority, origin, proposition, rationale,
         alternatives, constraints_note, scope_kind, scope_value, supersedes_revision_id, forgotten, project_generation, created_at)
       VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    ).run(
      revisionId,
      nextSeq(db),
      decisionId,
      cur.rev + 1,
      cur.origin,
      input.proposition,
      input.rationale ?? null,
      input.alternatives ?? null,
      input.constraintsNote ?? null,
      input.scopeKind,
      input.scopeValue ?? "",
      project.identity.generation,
      nowIso(),
    );
    // normal edits preserve the source-dependency set
    db.prepare(
      `INSERT INTO decision_sources(id, revision_id, kind, event_id, lineage, span_start, span_end, path, commit_oid,
         blob_oid, content_digest, line_start, line_end, encoding, object_format, worktree, git_ref_note, excerpt, snippet_hash, created_at)
       SELECT 'SRC-' || lower(hex(randomblob(16))), ?, kind, event_id, lineage, span_start, span_end, path, commit_oid,
         blob_oid, content_digest, line_start, line_end, encoding, object_format, worktree, git_ref_note, excerpt, snippet_hash, created_at
       FROM decision_sources WHERE revision_id = ?`,
    ).run(revisionId, cur.id);
    db.prepare("INSERT INTO decision_fts(revision_id, proposition, rationale) VALUES (?, ?, ?)").run(
      revisionId,
      input.proposition,
      input.rationale ?? "",
    );
    const upd = db
      .prepare("UPDATE decisions SET current_revision_id = ? WHERE id = ? AND current_revision_id = ?")
      .run(revisionId, decisionId, cur.id);
    if (Number(upd.changes) !== 1) throw staleRevision("concurrent revision change");
    db.exec("COMMIT");
    return { revisionId, rev: cur.rev + 1 };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
