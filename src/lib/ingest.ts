import type { DatabaseSync } from "node:sqlite";
import type { Project } from "./project.ts";
import { quotaCheck } from "./project.ts";
import { LIMITS, capacity, invalid, newId, nowIso, sha256Hex, truncateUtf8, utf8Bytes } from "./util.ts";

/** Closed set of retained event classes. Everything else is discarded. */
export type RetainedRole = "user" | "assistant" | "tool_input" | "tool_result";
const RETAINED_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "tool_input", "tool_result"]);

export type NormalizedEvent = {
  lineage: string; // opaque namespaced source-lineage key
  sourceEvent: string; // host event id or framing id
  revision: number;
  ord: number;
  role: RetainedRole;
  content: string;
  /** allowlisted scalar metadata only */
  meta?: Record<string, string | number | boolean>;
};

export type SessionSpec = {
  adapter: string;
  adapterVersion: string;
  sourceSession: string;
  sourceIdentity?: string;
  worktree?: string;
};

export type IngestReport = {
  sessionId: string;
  inserted: number;
  replayedNoop: number;
  conflicts: number;
  suppressed: number;
  discarded: number;
  truncatedEvents: number;
  coverage: { lineage: string; ordStart: number; ordEnd: number; status: string }[];
};

const META_ALLOWLIST = new Set([
  "parent_event",
  "host_generation",
  "compaction",
  "subagent",
  "tool_name",
  "model_surface",
  "fork_of",
  "unverified_ancestry",
]);

export function normalizeMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!META_ALLOWLIST.has(k)) continue; // unknown fields never enter metadata
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function isRetainedRole(role: string): role is RetainedRole {
  return RETAINED_ROLES.has(role);
}

function upsertSession(db: DatabaseSync, spec: SessionSpec, generation: string): string {
  const existing = db
    .prepare("SELECT id, project_generation FROM sessions WHERE adapter = ? AND source_session = ?")
    .get(spec.adapter, spec.sourceSession) as { id: string; project_generation: string } | undefined;
  if (existing) {
    if (existing.project_generation !== generation) {
      throw invalid("session belongs to a retired project generation");
    }
    return existing.id;
  }
  const id = newId("S");
  db.prepare(
    `INSERT INTO sessions(id, adapter, adapter_version, source_session, source_identity, project_generation, worktree, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    spec.adapter,
    spec.adapterVersion,
    spec.sourceSession,
    spec.sourceIdentity ?? null,
    generation,
    spec.worktree ?? null,
    nowIso(),
  );
  return id;
}

/**
 * One short SQLite transaction: validate generation and source binding, insert
 * events and FTS entries, record covered ranges, advance the cursor. Replay of
 * the same source identity + retained-normalized digest is a no-op; a
 * different retained payload for the same identity produces a bounded conflict
 * record. Suppressed identities (from forgetting) are never re-admitted.
 */
export function ingestBatch(
  project: Project,
  spec: SessionSpec,
  events: NormalizedEvent[],
  opts: { coverageStatus?: "complete" | "unverified" } = {},
): IngestReport {
  if (events.length > LIMITS.maxEventsPerOperation) {
    throw capacity(`batch exceeds ${LIMITS.maxEventsPerOperation} events per operation`);
  }
  let batchBytes = 0;
  for (const e of events) batchBytes += utf8Bytes(e.content);
  if (batchBytes > LIMITS.maxImportBatchBytes) {
    throw capacity(`batch exceeds ${LIMITS.maxImportBatchBytes} bytes per import transaction`);
  }
  quotaCheck(project, batchBytes);

  const db = project.db;
  const generation = project.identity.generation;
  const report: IngestReport = {
    sessionId: "",
    inserted: 0,
    replayedNoop: 0,
    conflicts: 0,
    suppressed: 0,
    discarded: 0,
    truncatedEvents: 0,
    coverage: [],
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-check generation inside the transaction (races forget/purge).
    const gen = db.prepare("SELECT value FROM meta WHERE key = 'project_generation'").get() as
      | { value: string }
      | undefined;
    if (!gen || gen.value !== generation) throw invalid("project generation changed during ingest");

    const sessionId = upsertSession(db, spec, generation);
    report.sessionId = sessionId;

    if (
      db.prepare("SELECT 1 FROM suppressions WHERE kind = 'session' AND identity = ?").get(
        `${spec.adapter}:${spec.sourceSession}`,
      )
    ) {
      report.suppressed = events.length;
      db.exec("COMMIT");
      return report;
    }

    const findEvent = db.prepare(
      "SELECT id, digest FROM events WHERE session_id = ? AND lineage = ? AND source_event = ? AND revision = ?",
    );
    const insertEvent = db.prepare(
      `INSERT INTO events(id, session_id, lineage, source_event, revision, ord, role, content, digest, truncated, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare("INSERT INTO event_fts(event_id, content) VALUES (?, ?)");
    const insertConflict = db.prepare(
      "INSERT INTO conflicts(session_id, lineage, source_event, revision, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const eventSuppressed = db.prepare(
      "SELECT 1 FROM suppressions WHERE kind = 'event' AND identity = ?",
    );
    const lineageSuppressed = db.prepare(
      "SELECT 1 FROM suppressions WHERE kind = 'lineage' AND identity = ?",
    );

    const lineageBounds = new Map<string, { min: number; max: number }>();

    for (const ev of events) {
      if (!isRetainedRole(ev.role)) {
        report.discarded++;
        continue;
      }
      if (lineageSuppressed.get(`${spec.adapter}:${spec.sourceSession}:${ev.lineage}`)) {
        report.suppressed++;
        continue;
      }
      const suppressionKey = `${spec.adapter}:${spec.sourceSession}:${ev.lineage}:${ev.sourceEvent}:${ev.revision}`;
      if (eventSuppressed.get(suppressionKey)) {
        report.suppressed++;
        continue;
      }
      let [content, truncated] = truncateUtf8(ev.content, LIMITS.maxEventBytes);
      if (truncated) report.truncatedEvents++;
      const digest = sha256Hex(content);
      const existing = findEvent.get(sessionId, ev.lineage, ev.sourceEvent, ev.revision) as
        | { id: string; digest: string }
        | undefined;
      if (existing) {
        if (existing.digest === digest) {
          report.replayedNoop++;
        } else {
          insertConflict.run(sessionId, ev.lineage, ev.sourceEvent, ev.revision, "digest-mismatch-on-replay", nowIso());
          report.conflicts++;
        }
        continue;
      }
      const id = newId("E");
      insertEvent.run(
        id,
        sessionId,
        ev.lineage,
        ev.sourceEvent,
        ev.revision,
        ev.ord,
        ev.role,
        content,
        digest,
        truncated ? 1 : 0,
        ev.meta ? JSON.stringify(normalizeMeta(ev.meta) ?? {}) : null,
        nowIso(),
      );
      insertFts.run(id, content);
      report.inserted++;
      const b = lineageBounds.get(ev.lineage);
      if (!b) lineageBounds.set(ev.lineage, { min: ev.ord, max: ev.ord });
      else {
        b.min = Math.min(b.min, ev.ord);
        b.max = Math.max(b.max, ev.ord);
      }
    }

    const status = opts.coverageStatus ?? "complete";
    const insertCoverage = db.prepare(
      "INSERT INTO coverage(session_id, lineage, ord_start, ord_end, status) VALUES (?, ?, ?, ?, ?)",
    );
    const upsertCursor = db.prepare(
      `INSERT INTO cursors(session_id, lineage, position, source_identity) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, lineage) DO UPDATE SET position = MAX(position, excluded.position), source_identity = excluded.source_identity`,
    );
    for (const [lineage, b] of lineageBounds) {
      insertCoverage.run(sessionId, lineage, b.min, b.max, status);
      upsertCursor.run(sessionId, lineage, b.max, spec.sourceIdentity ?? "");
      report.coverage.push({ lineage, ordStart: b.min, ordEnd: b.max, status });
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return report;
}
