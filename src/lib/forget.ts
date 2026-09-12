import type { DatabaseSync } from "node:sqlite";
import type { Project } from "./project.ts";
import { invalid, nowIso } from "./util.ts";

export type ForgetPreview = {
  sessions: number;
  events: number;
  decisionsRemoved: string[];
  markersRetained: string[];
  boundaries: string[];
};

const BOUNDARIES = [
  "the repository and its Git history are NOT deleted",
  "an independently managed zvec code index is NOT deleted",
  "coding-host transcript copies are NOT deleted",
  "user-created exports are NOT deleted",
];

function eventIdsOfSession(db: DatabaseSync, sessionId: string): string[] {
  return (db.prepare("SELECT id FROM events WHERE session_id = ?").all(sessionId) as { id: string }[]).map(
    (r) => r.id,
  );
}

function decisionsDependingOnEvents(db: DatabaseSync, eventIds: string[]): string[] {
  if (eventIds.length === 0) return [];
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT dr.decision_id AS did
       FROM decision_sources ds JOIN decision_revisions dr ON ds.revision_id = dr.id
       WHERE ds.event_id IN (${placeholders})`,
    )
    .all(...eventIds) as { did: string }[];
  return rows.map((r) => r.did);
}

/**
 * Remove all content of the given decisions. A revision referenced by a
 * SURVIVING revision's supersession pointer is kept only as a non-content
 * marker (forgotten=1): text, anchors, source links and earlier-chain links
 * removed. Everything else is deleted. Runs inside the caller's transaction.
 */
function deleteDecisionsContent(db: DatabaseSync, decisionIds: string[]): { removed: string[]; markers: string[] } {
  if (decisionIds.length === 0) return { removed: [], markers: [] };
  const dPlace = decisionIds.map(() => "?").join(",");
  const doomedRevisions = (
    db
      .prepare(`SELECT id FROM decision_revisions WHERE decision_id IN (${dPlace})`)
      .all(...decisionIds) as { id: string }[]
  ).map((r) => r.id);
  const doomedSet = new Set(doomedRevisions);

  // Which doomed revisions are referenced by a surviving successor?
  const markers: string[] = [];
  for (const revId of doomedRevisions) {
    const refs = db
      .prepare("SELECT id, decision_id FROM decision_revisions WHERE supersedes_revision_id = ?")
      .all(revId) as { id: string; decision_id: string }[];
    const survivingRef = refs.some((r) => !doomedSet.has(r.id));
    if (survivingRef) markers.push(revId);
  }
  const markerSet = new Set(markers);

  // Clear current pointers first (FK-in-code) so revision deletes are safe.
  db.prepare(`UPDATE decisions SET current_revision_id = NULL WHERE id IN (${dPlace})`).run(...decisionIds);

  // FTS rows for every doomed revision (markers lose searchable content too).
  for (const revId of doomedRevisions) {
    db.prepare("DELETE FROM decision_fts WHERE revision_id = ?").run(revId);
  }

  // Convert referenced revisions to non-content markers.
  for (const revId of markers) {
    db.prepare("DELETE FROM decision_sources WHERE revision_id = ?").run(revId);
    db.prepare(
      `UPDATE decision_revisions SET forgotten = 1, proposition = NULL, rationale = NULL,
         alternatives = NULL, constraints_note = NULL, supersedes_revision_id = NULL
       WHERE id = ?`,
    ).run(revId);
  }

  // Delete the rest. Sources cascade on revision delete. Delete in reverse
  // seq order so intra-batch supersession pointers never dangle mid-delete.
  const rest = (
    db
      .prepare(
        `SELECT id FROM decision_revisions WHERE decision_id IN (${dPlace}) AND forgotten = 0 ORDER BY seq DESC`,
      )
      .all(...decisionIds) as { id: string }[]
  )
    .map((r) => r.id)
    .filter((id) => !markerSet.has(id));
  for (const revId of rest) {
    // any pointer from a doomed revision to a surviving one disappears with it;
    // pointers from surviving revisions to this one were converted to markers above
    db.prepare("DELETE FROM decision_revisions WHERE id = ?").run(revId);
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const did of decisionIds) {
    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM decision_revisions WHERE decision_id = ?")
      .get(did) as { c: number };
    if (remaining.c === 0) {
      db.prepare("DELETE FROM decisions WHERE id = ?").run(did);
      removed.push(did);
    } else {
      kept.push(did); // marker-only shell; current_revision_id stays NULL
      removed.push(did);
    }
  }
  return { removed, markers };
}

export function previewForgetSession(project: Project, sessionId: string): ForgetPreview {
  const db = project.db;
  const sess = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (!sess) throw invalid(`unknown session: ${sessionId}`);
  const eventIds = eventIdsOfSession(db, sessionId);
  const affected = decisionsDependingOnEvents(db, eventIds);
  return {
    sessions: 1,
    events: eventIds.length,
    decisionsRemoved: affected,
    markersRetained: [],
    boundaries: BOUNDARIES,
  };
}

/**
 * Serialized project write transaction: delete session events, dependent
 * excerpts, FTS entries and dependent decisions; insert non-content
 * suppressions that block automatic replay.
 */
export function forgetSession(project: Project, sessionId: string): ForgetPreview {
  const db = project.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const gen = db.prepare("SELECT value FROM meta WHERE key = 'project_generation'").get() as {
      value: string;
    };
    if (gen.value !== project.identity.generation) throw invalid("project generation changed during forget");
    const sess = db
      .prepare("SELECT id, adapter, source_session FROM sessions WHERE id = ?")
      .get(sessionId) as { id: string; adapter: string; source_session: string } | undefined;
    if (!sess) throw invalid(`unknown session: ${sessionId}`);

    const eventIds = eventIdsOfSession(db, sessionId);
    const affected = decisionsDependingOnEvents(db, eventIds);
    const { removed, markers } = deleteDecisionsContent(db, affected);

    for (const evId of eventIds) {
      db.prepare("DELETE FROM event_fts WHERE event_id = ?").run(evId);
    }
    // session delete cascades events, coverage, cursors
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.prepare("DELETE FROM conflicts WHERE session_id = ?").run(sessionId);
    db.prepare(
      "INSERT OR IGNORE INTO suppressions(kind, identity, created_at) VALUES ('session', ?, ?)",
    ).run(`${sess.adapter}:${sess.source_session}`, nowIso());

    db.exec("COMMIT");
    return {
      sessions: 1,
      events: eventIds.length,
      decisionsRemoved: removed,
      markersRetained: markers,
      boundaries: BOUNDARIES,
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Forget a decision alone: removes its revisions and owned excerpts; shared
 * session events used by other decisions are NOT deleted.
 */
export function forgetDecision(project: Project, decisionId: string): ForgetPreview {
  const db = project.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const gen = db.prepare("SELECT value FROM meta WHERE key = 'project_generation'").get() as {
      value: string;
    };
    if (gen.value !== project.identity.generation) throw invalid("project generation changed during forget");
    const d = db.prepare("SELECT id FROM decisions WHERE id = ?").get(decisionId);
    if (!d) throw invalid(`unknown decision: ${decisionId}`);
    const { removed, markers } = deleteDecisionsContent(db, [decisionId]);
    db.exec("COMMIT");
    return {
      sessions: 0,
      events: 0,
      decisionsRemoved: removed,
      markersRetained: markers,
      boundaries: BOUNDARIES,
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
