import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, ensurePrivateDir, pmHome, notRegistered, invalid } from "./util.ts";

/**
 * Discovery registry: maps roots to candidate databases. It holds NO mutable
 * decision state; the database's own project identity is authoritative and is
 * re-verified on every open. Retired generations survive database deletion so
 * old writers stay rejected after purge.
 */
export type RegistryEntry = {
  projectId: string;
  root: string; // canonical (realpath at registration)
  dbPath: string;
};

export type RegistryFile = {
  version: 1;
  projects: RegistryEntry[];
  retiredGenerations: string[];
};

const EMPTY: RegistryFile = { version: 1, projects: [], retiredGenerations: [] };

export function registryPath(): string {
  return join(pmHome(), "registry.json");
}

export function loadRegistry(): RegistryFile {
  const p = registryPath();
  if (!existsSync(p)) return structuredClone(EMPTY);
  const raw = JSON.parse(readFileSync(p, "utf8")) as RegistryFile;
  if (raw.version !== 1) throw invalid(`unsupported registry version ${String(raw.version)}`);
  raw.retiredGenerations ??= [];
  raw.projects ??= [];
  return raw;
}

export function saveRegistry(reg: RegistryFile): void {
  ensurePrivateDir(pmHome());
  atomicWriteFile(registryPath(), JSON.stringify(reg, null, 2));
}

export function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    throw invalid(`project root does not exist: ${root}`);
  }
}

/** Locate the candidate entry for a directory (exact canonical root match). */
export function findEntryForRoot(root: string): RegistryEntry | undefined {
  const canonical = canonicalRoot(root);
  const reg = loadRegistry();
  return reg.projects.find((p) => p.root === canonical);
}

export function requireEntryForRoot(root: string): RegistryEntry {
  const e = findEntryForRoot(root);
  if (!e) throw notRegistered(`no registered project for root: ${root} (run pm init)`);
  return e;
}

export function addEntry(entry: RegistryEntry): void {
  const reg = loadRegistry();
  if (reg.projects.some((p) => p.root === entry.root)) {
    throw invalid(`root already registered: ${entry.root}`);
  }
  reg.projects.push(entry);
  saveRegistry(reg);
}

export function removeEntry(projectId: string): void {
  const reg = loadRegistry();
  reg.projects = reg.projects.filter((p) => p.projectId !== projectId);
  saveRegistry(reg);
}

export function retireGeneration(generation: string): void {
  const reg = loadRegistry();
  if (!reg.retiredGenerations.includes(generation)) {
    reg.retiredGenerations.push(generation);
    saveRegistry(reg);
  }
}

export function isGenerationRetired(generation: string): boolean {
  return loadRegistry().retiredGenerations.includes(generation);
}
