import type { Project } from "./project.ts";
import { checkApplicability } from "./anchors.ts";
import { fileHistory } from "./git.ts";
import { invalid, LIMITS } from "./util.ts";

/** pm why <file>:<line> — decisions anchored at this exact location. */
export function whyAt(project: Project, relPath: string, line: number) {
  const db = project.db;
  const rows = db
    .prepare(
      `SELECT dr.decision_id, dr.rev, dr.authority, dr.origin, dr.proposition, dr.scope_kind, dr.scope_value,
              ds.id AS source_id, ds.path, ds.content_digest, ds.line_start, ds.line_end
       FROM decision_sources ds
       JOIN decision_revisions dr ON ds.revision_id = dr.id
       JOIN decisions d ON d.current_revision_id = dr.id
       WHERE dr.forgotten = 0 AND ds.kind = 'code' AND ds.path = ?
         AND ds.line_start <= ? AND ds.line_end >= ?
       LIMIT ?`,
    )
    .all(relPath, line, line, LIMITS.maxDecisionCandidates) as Record<string, unknown>[];
  return rows.map((r) => ({
    decision: r.decision_id,
    rev: r.rev,
    authority: r.authority,
    origin: r.origin,
    proposition: r.proposition,
    scope: `${String(r.scope_kind)}${r.scope_value ? ":" + String(r.scope_value) : ""}`,
    anchor: { path: r.path, lines: `${String(r.line_start)}–${String(r.line_end)}` },
    applicability: checkApplicability(project, {
      path: r.path as string,
      content_digest: r.content_digest as string,
      line_start: r.line_start as number,
      line_end: r.line_end as number,
    }),
  }));
}

/** pm search — FTS over decision text and retained event content. */
export function searchMemory(project: Project, query: string, limit = 10) {
  const db = project.db;
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2)
    .map((t) => `"${t}"`)
    .join(" OR ");
  if (!terms) throw invalid("query has no searchable terms");
  const decisions = db
    .prepare(
      `SELECT dr.decision_id AS id, dr.rev, dr.authority, dr.proposition,
              snippet(decision_fts, 1, '[', ']', '…', 12) AS snip
       FROM decision_fts
       JOIN decision_revisions dr ON dr.id = decision_fts.revision_id
       JOIN decisions d ON d.current_revision_id = dr.id
       WHERE decision_fts MATCH ? AND dr.forgotten = 0
       ORDER BY rank LIMIT ?`,
    )
    .all(terms, limit) as Record<string, unknown>[];
  const events = db
    .prepare(
      `SELECT e.id, e.session_id, e.lineage, e.role,
              snippet(event_fts, 1, '[', ']', '…', 12) AS snip
       FROM event_fts JOIN events e ON e.id = event_fts.event_id
       WHERE event_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(terms, limit) as Record<string, unknown>[];
  return { decisions, events };
}

/** pm inspect <decision> [--sources] — full detail including source excerpts. */
export function inspectDecision(project: Project, decisionId: string, withSources: boolean) {
  const db = project.db;
  const d = db.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId) as
    | { id: string; current_revision_id: string | null; created_at: string }
    | undefined;
  if (!d) throw invalid(`unknown decision: ${decisionId}`);
  const revisions = db
    .prepare("SELECT * FROM decision_revisions WHERE decision_id = ? ORDER BY rev")
    .all(decisionId) as Record<string, unknown>[];
  const out: Record<string, unknown> = {
    id: d.id,
    currentRevisionId: d.current_revision_id,
    createdAt: d.created_at,
    revisions: revisions.map((r) => {
      const rev: Record<string, unknown> = {
        revisionId: r.id,
        rev: r.rev,
        seq: r.seq,
        authority: r.forgotten ? "forgotten" : r.authority,
        origin: r.origin,
        forgotten: !!r.forgotten,
        proposition: r.proposition,
        rationale: r.rationale,
        scope: `${String(r.scope_kind)}${r.scope_value ? ":" + String(r.scope_value) : ""}`,
        supersedes: r.supersedes_revision_id,
      };
      if (r.supersedes_revision_id) {
        const pred = db
          .prepare("SELECT forgotten FROM decision_revisions WHERE id = ?")
          .get(r.supersedes_revision_id as string) as { forgotten: number } | undefined;
        if (!pred) rev.predecessorStatus = "missing (integrity error)";
        else if (pred.forgotten) rev.predecessorStatus = "predecessor-forgotten";
      }
      if (withSources) {
        rev.sources = db
          .prepare(
            `SELECT id, kind, event_id, lineage, span_start, span_end, path, commit_oid, blob_oid,
                    content_digest, line_start, line_end, excerpt FROM decision_sources WHERE revision_id = ?`,
          )
          .all(r.id as string);
      }
      return rev;
    }),
  };
  return out;
}

/** pm history --file — decision anchors + bounded git history for a file. */
export function historyForFile(project: Project, relPath: string) {
  const db = project.db;
  const anchors = db
    .prepare(
      `SELECT dr.decision_id, dr.rev, dr.authority, dr.forgotten, ds.line_start, ds.line_end, ds.commit_oid, ds.content_digest
       FROM decision_sources ds JOIN decision_revisions dr ON ds.revision_id = dr.id
       WHERE ds.kind = 'code' AND ds.path = ? LIMIT 100`,
    )
    .all(relPath) as Record<string, unknown>[];
  const git =
    project.git.isRepo && !project.git.enrichmentDisabled
      ? fileHistory(project.identity.root, relPath).map((c) => ({
          kind: "historical-clue" as const,
          oid: c.oid.slice(0, 12),
          date: c.date,
          subject: c.subject,
        }))
      : [];
  return {
    file: relPath,
    decisionAnchors: anchors.map((a) => ({
      decision: a.decision_id,
      rev: a.rev,
      authority: a.forgotten ? "forgotten" : a.authority,
      lines: `${String(a.line_start)}–${String(a.line_end)}`,
      commit: a.commit_oid ? String(a.commit_oid).slice(0, 12) : null,
      contentVersion: String(a.content_digest ?? "").slice(0, 12),
    })),
    gitHistory: git,
    note: "git commits are historical clues, not confirmed decisions",
  };
}

/** pm export — JSONL of decisions with sources and sessions/events. */
export function exportMemory(project: Project): string[] {
  const db = project.db;
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "header",
      schema: 1,
      projectId: project.identity.projectId,
      root: project.identity.root,
      exportedAt: new Date().toISOString(),
      note: "private export; excluded from code indexing and version control by default",
    }),
  );
  const sessions = db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
  for (const s of sessions) lines.push(JSON.stringify({ type: "session", ...s }));
  // named permitted content columns only — no generic metadata serialization
  const events = db
    .prepare(
      "SELECT id, session_id, lineage, source_event, revision, ord, role, content, digest, truncated FROM events ORDER BY session_id, lineage, ord",
    )
    .all() as Record<string, unknown>[];
  for (const e of events) lines.push(JSON.stringify({ type: "event", ...e }));
  const decisions = db.prepare("SELECT * FROM decisions").all() as Record<string, unknown>[];
  for (const d of decisions) {
    const revisions = db
      .prepare(
        `SELECT id, seq, decision_id, rev, authority, origin, proposition, rationale, alternatives,
                constraints_note, scope_kind, scope_value, supersedes_revision_id, forgotten, created_at
         FROM decision_revisions WHERE decision_id = ? ORDER BY rev`,
      )
      .all(d.id as string) as Record<string, unknown>[];
    const withSources = revisions.map((r) => ({
      ...r,
      sources: db
        .prepare(
          `SELECT id, kind, event_id, lineage, span_start, span_end, path, commit_oid, blob_oid,
                  content_digest, line_start, line_end, encoding, excerpt FROM decision_sources WHERE revision_id = ?`,
        )
        .all(r.id as string),
    }));
    lines.push(JSON.stringify({ type: "decision", ...d, revisions: withSources }));
  }
  return lines;
}
