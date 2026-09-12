import { backup as sqliteBackup } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, getMeta, setMeta, SCHEMA_VERSION, verifyIdentity } from "./db.ts";
import { openProject, projectDataDir } from "./project.ts";
import { canonicalRoot, requireEntryForRoot, retireGeneration } from "./registry.ts";
import { atomicWriteFile, ensurePrivateDir, invalid, newGeneration, nowIso } from "./util.ts";

export type BackupManifest = {
  schema: number;
  projectId: string;
  root: string;
  generation: string;
  createdAt: string;
  note: string;
};

/**
 * Consistent SQLite backup via the online backup API (never a raw copy that
 * omits live WAL). Writes <name>.db plus a manifest with schema version,
 * project identity and retention boundary.
 */
export async function backupProject(root: string, outPath: string): Promise<BackupManifest> {
  const project = openProject(root);
  try {
    ensurePrivateDir(dirname(outPath));
    if (existsSync(outPath)) throw invalid(`backup target exists: ${outPath}`);
    await sqliteBackup(project.db, outPath);
    const manifest: BackupManifest = {
      schema: SCHEMA_VERSION,
      projectId: project.identity.projectId,
      root: project.identity.root,
      generation: project.identity.generation,
      createdAt: nowIso(),
      note: "backup may contain formerly forgotten records created before later forget operations",
    };
    atomicWriteFile(outPath + ".manifest.json", JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    project.db.close();
  }
}

export type RestoreResult = {
  projectId: string;
  newGeneration: string;
  captureEnabled: false;
  acknowledgement: string;
};

/**
 * Restore into an already-registered project root. Begins with capture
 * disabled and a NEW project_generation; the previous generation is retired so
 * stale writers/callbacks stay rejected. Does not reconnect adapters or index
 * restored content.
 */
export async function restoreProject(root: string, backupPath: string): Promise<RestoreResult> {
  const canonical = canonicalRoot(root);
  const entry = requireEntryForRoot(canonical);
  if (!existsSync(backupPath)) throw invalid(`backup file missing: ${backupPath}`);

  // Retire the live generation first (writers disabled before replacement).
  let oldGeneration = "";
  if (existsSync(entry.dbPath)) {
    const live = openDb(entry.dbPath);
    try {
      oldGeneration = getMeta(live, "project_generation") ?? "";
      setMeta(live, "lifecycle", "restoring");
      live.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      live.close();
    }
  }
  if (oldGeneration) retireGeneration(oldGeneration);

  // Copy the snapshot in via the backup API (consistent read of the snapshot).
  const src = openDb(backupPath);
  const staging = join(projectDataDir(entry.projectId), `restore-${randomUUID()}.db`);
  try {
    const schemaVersion = Number(getMeta(src, "schema_version"));
    if (schemaVersion !== SCHEMA_VERSION) {
      throw invalid(`backup schema ${schemaVersion} incompatible with supported ${SCHEMA_VERSION}`);
    }
    const backupProjectId = getMeta(src, "project_id");
    if (backupProjectId !== entry.projectId) {
      throw invalid(
        `backup belongs to project ${backupProjectId}, not ${entry.projectId}; a different project requires explicit re-registration`,
      );
    }
    await sqliteBackup(src, staging);
  } finally {
    src.close();
  }

  const generation = newGeneration();
  const staged = openDb(staging);
  try {
    setMeta(staged, "project_generation", generation);
    setMeta(staged, "lifecycle", "active");
    setMeta(staged, "capture_enabled", "0");
    setMeta(staged, "approved_root", entry.root);
    staged.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    staged.close();
  }
  const { renameSync, rmSync } = await import("node:fs");
  rmSync(entry.dbPath, { force: true });
  rmSync(entry.dbPath + "-wal", { force: true });
  rmSync(entry.dbPath + "-shm", { force: true });
  renameSync(staging, entry.dbPath);

  // sanity: verify restored identity
  const check = openDb(entry.dbPath);
  try {
    verifyIdentity(check, { projectId: entry.projectId, root: entry.root });
  } finally {
    check.close();
  }
  return {
    projectId: entry.projectId,
    newGeneration: generation,
    captureEnabled: false,
    acknowledgement:
      "restored snapshot may contain formerly forgotten records; capture is disabled; adapters are not reconnected; nothing was uploaded or indexed",
  };
}
