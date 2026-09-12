import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir, invalid, notRegistered, PmError } from "./util.ts";
import { isGenerationRetired } from "./registry.ts";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  source_session TEXT NOT NULL,
  source_identity TEXT,             -- adapter-specific stable source identity (file digest prefix etc.)
  project_generation TEXT NOT NULL,
  worktree TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(adapter, source_session)
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lineage TEXT NOT NULL,            -- opaque namespaced source-lineage key
  source_event TEXT NOT NULL,       -- host event id or framing id
  revision INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL,             -- order within lineage
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool_input','tool_result')),
  content TEXT NOT NULL,            -- retained visible content (bounded)
  digest TEXT NOT NULL,             -- retained-normalized content digest
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  meta TEXT,                        -- allowlisted scalar metadata JSON, non-searchable
  created_at TEXT NOT NULL,
  UNIQUE(session_id, lineage, source_event, revision)
) STRICT;
CREATE INDEX idx_events_session ON events(session_id, lineage, ord);

CREATE TABLE coverage (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lineage TEXT NOT NULL,
  ord_start INTEGER NOT NULL,
  ord_end INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete','gap','unverified'))
) STRICT;

CREATE TABLE cursors (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lineage TEXT NOT NULL,
  position INTEGER NOT NULL,
  source_identity TEXT NOT NULL,
  PRIMARY KEY (session_id, lineage)
) STRICT;

CREATE TABLE conflicts (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  lineage TEXT NOT NULL,
  source_event TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reason TEXT NOT NULL,             -- content-free diagnostic
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  current_revision_id TEXT,         -- FK enforced in code (circular)
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE decision_revisions (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,      -- DB-wide increasing creation sequence
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  authority TEXT NOT NULL CHECK (authority IN ('candidate','confirmed','rejected','superseded')),
  origin TEXT NOT NULL CHECK (origin IN ('developer','assistant','git','import')),
  proposition TEXT,                 -- NULL only when forgotten=1
  rationale TEXT,
  alternatives TEXT,                -- optional rejected alternatives
  constraints_note TEXT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project','package','path','file','range','revision')),
  scope_value TEXT NOT NULL DEFAULT '',
  supersedes_revision_id TEXT REFERENCES decision_revisions(id),
  forgotten INTEGER NOT NULL DEFAULT 0 CHECK (forgotten IN (0,1)),
  project_generation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(decision_id, rev),
  CHECK (forgotten = 1 OR proposition IS NOT NULL)
) STRICT;
-- one active successor per superseded revision
CREATE UNIQUE INDEX idx_one_successor ON decision_revisions(supersedes_revision_id)
  WHERE supersedes_revision_id IS NOT NULL;

CREATE TABLE decision_sources (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES decision_revisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event','code','git','manual')),
  -- event sources
  event_id TEXT REFERENCES events(id),
  lineage TEXT,
  span_start INTEGER,               -- 1-based line span within retained content
  span_end INTEGER,
  -- code anchors (exact versioned)
  path TEXT,                        -- repository-relative or root-relative
  commit_oid TEXT,                  -- NULL for uncommitted
  blob_oid TEXT,
  content_digest TEXT,              -- sha256 of file bytes at capture
  line_start INTEGER,
  line_end INTEGER,
  encoding TEXT DEFAULT 'utf-8',
  object_format TEXT,               -- sha1 | sha256 (git)
  worktree TEXT,
  -- git evidence
  git_ref_note TEXT,                -- e.g. commit subject; historical clue text
  -- all kinds
  excerpt TEXT,                     -- bounded retained excerpt (survives upstream loss)
  snippet_hash TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_sources_revision ON decision_sources(revision_id);
CREATE INDEX idx_sources_event ON decision_sources(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_sources_path ON decision_sources(path, content_digest) WHERE path IS NOT NULL;

CREATE TABLE proposal_receipts (
  request_id TEXT PRIMARY KEY,      -- caller id namespaced by project/session/lineage
  project_generation TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  decision_ids TEXT NOT NULL,       -- JSON array of created decision ids
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE suppressions (
  kind TEXT NOT NULL CHECK (kind IN ('session','event','lineage')),
  identity TEXT NOT NULL,           -- non-content replay barrier
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, identity)
) STRICT;

CREATE VIRTUAL TABLE event_fts USING fts5(event_id UNINDEXED, content);
CREATE VIRTUAL TABLE decision_fts USING fts5(revision_id UNINDEXED, proposition, rationale);
`;

export type Db = DatabaseSync;

export function openDb(dbPath: string, opts: { create?: boolean } = {}): DatabaseSync {
  if (!opts.create && !existsSync(dbPath)) {
    throw notRegistered(`project database missing: ${dbPath}`);
  }
  ensurePrivateDir(dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 2000");
  return db;
}

export function initSchema(db: DatabaseSync, meta: Record<string, string>): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA);
    const ins = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    ins.run("schema_version", String(SCHEMA_VERSION));
    for (const [k, v] of Object.entries(meta)) ins.run(k, v);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export type ProjectIdentity = {
  projectId: string;
  generation: string;
  root: string;
  lifecycle: string;
  schemaVersion: number;
};

/**
 * Verify database project identity against the registry entry before any
 * read/write. The database is authoritative; the registry only locates it.
 */
export function verifyIdentity(
  db: DatabaseSync,
  expected: { projectId: string; root: string },
): ProjectIdentity {
  const schemaVersion = Number(getMeta(db, "schema_version"));
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new PmError(
      "incompatible-schema",
      `database schema ${schemaVersion} incompatible with supported ${SCHEMA_VERSION}`,
      3,
    );
  }
  const projectId = getMeta(db, "project_id");
  const generation = getMeta(db, "project_generation");
  const root = getMeta(db, "approved_root");
  const lifecycle = getMeta(db, "lifecycle") ?? "active";
  if (!projectId || !generation || !root) {
    throw invalid("database missing project identity");
  }
  if (projectId !== expected.projectId) {
    throw notRegistered(
      `database project identity ${projectId} does not match registry ${expected.projectId}`,
    );
  }
  if (root !== expected.root) {
    throw notRegistered(
      `database approved root ${root} does not match ${expected.root}; a moved root needs explicit re-registration`,
    );
  }
  if (lifecycle !== "active") {
    throw notRegistered(`project lifecycle is '${lifecycle}', not active`);
  }
  if (isGenerationRetired(generation)) {
    throw notRegistered("project generation is retired");
  }
  return { projectId, generation, root, lifecycle, schemaVersion: SCHEMA_VERSION };
}

export function nextSeq(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM decision_revisions")
    .get() as { next: number };
  return row.next;
}

/** Whole controlled database size (pages * page_size), counting WAL. */
export function dbSizeBytes(db: DatabaseSync): number {
  const pc = db.prepare("PRAGMA page_count").get() as { page_count: number };
  const ps = db.prepare("PRAGMA page_size").get() as { page_size: number };
  const wal = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  const walPages = Math.max(0, wal.log);
  return (pc.page_count + walPages) * ps.page_size;
}
