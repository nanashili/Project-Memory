import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDb, initSchema, verifyIdentity, getMeta, setMeta, dbSizeBytes, type ProjectIdentity } from "./db.ts";
import {
  addEntry,
  canonicalRoot,
  findEntryForRoot,
  removeEntry,
  requireEntryForRoot,
  retireGeneration,
  type RegistryEntry,
} from "./registry.ts";
import { capacity, ensurePrivateDir, invalid, newGeneration, nowIso, pmHome, LIMITS } from "./util.ts";
import { inspectGitLayout, type GitLayout } from "./git.ts";

export type Project = {
  db: DatabaseSync;
  identity: ProjectIdentity;
  entry: RegistryEntry;
  git: GitLayout;
};

export function projectDataDir(projectId: string): string {
  return join(pmHome(), "projects", projectId);
}

export function initProject(rootInput: string): { projectId: string; dbPath: string; root: string } {
  const root = canonicalRoot(rootInput);
  if (findEntryForRoot(root)) throw invalid(`root already registered: ${root}`);
  const projectId = randomUUID();
  const dir = projectDataDir(projectId);
  ensurePrivateDir(dir);
  const dbPath = join(dir, "memory.db");
  const git = inspectGitLayout(root);
  const db = openDb(dbPath, { create: true });
  try {
    initSchema(db, {
      project_id: projectId,
      project_generation: newGeneration(),
      approved_root: root,
      lifecycle: "active",
      created_at: nowIso(),
      git_common_dir: git.commonDir ?? "",
      git_object_format: git.objectFormat ?? "",
      quota_bytes: String(LIMITS.defaultProjectBudgetBytes),
      capture_enabled: "0",
      index_enabled: "0",
    });
  } finally {
    db.close();
  }
  addEntry({ projectId, root, dbPath });
  return { projectId, dbPath, root };
}

/** Open + verify identity; the single entry point for all project operations. */
export function openProject(rootInput: string): Project {
  const entry = requireEntryForRoot(rootInput);
  const db = openDb(entry.dbPath);
  let identity: ProjectIdentity;
  try {
    identity = verifyIdentity(db, { projectId: entry.projectId, root: entry.root });
  } catch (e) {
    db.close();
    throw e;
  }
  const git = inspectGitLayout(entry.root);
  return { db, identity, entry, git };
}

export type PurgeResult = {
  projectId: string;
  retiredGeneration: string;
  deleted: string[];
  boundaries: string[];
};

/**
 * Full purge: disable registration and writers first (lifecycle=retired,
 * generation retired in registry — survives DB deletion), then remove the
 * database. Explicitly reports what purge does NOT delete.
 */
export function purgeProject(rootInput: string): PurgeResult {
  const entry = requireEntryForRoot(rootInput);
  const deleted: string[] = [];
  let generation = "";
  if (existsSync(entry.dbPath)) {
    const db = openDb(entry.dbPath);
    try {
      generation = getMeta(db, "project_generation") ?? "";
      setMeta(db, "lifecycle", "retired");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }
  if (generation) retireGeneration(generation);
  const dir = projectDataDir(entry.projectId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    deleted.push(dir);
  }
  removeEntry(entry.projectId);
  return {
    projectId: entry.projectId,
    retiredGeneration: generation,
    deleted,
    boundaries: [
      "the repository and its Git history are NOT deleted",
      "an independently managed zvec code index is NOT deleted",
      "coding-host transcript copies are NOT deleted",
      "user-created exports are NOT deleted",
      "residual bytes may remain on snapshotting/SSD filesystems; no physical erasure is promised",
    ],
  };
}

export function quotaCheck(p: Project, incomingBytes: number): void {
  const quota = Number(getMeta(p.db, "quota_bytes") ?? LIMITS.defaultProjectBudgetBytes);
  const size = dbSizeBytes(p.db);
  if (size + incomingBytes > quota) {
    throw capacity(
      `project retained budget reached (${size} + ${incomingBytes} > ${quota} bytes); admission stopped — nothing was silently evicted`,
    );
  }
}
