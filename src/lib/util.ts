import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const LIMITS = {
  maxEventBytes: 256 * 1024, // per normalized event
  maxImportBatchBytes: 8 * 1024 * 1024, // per import transaction batch
  maxImportFileBytes: 100 * 1024 * 1024, // per explicit transcript import
  maxEventsPerOperation: 10_000,
  defaultProjectBudgetBytes: 1024 * 1024 * 1024, // 1 GiB retained project budget
  captureDeadlineMs: 250,
  contextDeadlineMs: 2_000,
  defaultOrientationBytes: 2_048,
  defaultTaskPacketBytes: 8_192,
  maxDecisionCandidates: 10,
  maxCodeCandidates: 20,
  maxDefaultSourceExpansions: 2,
  maxExcerptBytes: 4 * 1024, // bounded retained excerpt per source
  maxGitOutputBytes: 2 * 1024 * 1024,
  maxGitHistoryWindow: 50, // commits per history query
  zvecWorkerTimeoutMs: 10_000,
  zvecMaxResults: 20,
} as const;

export class PmError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

// Exit codes: 0 ok, 1 invalid input, 2 not registered / wrong project,
// 3 dependency failure, 4 insufficient budget, 5 capacity, 6 conflict/stale revision.
export const invalid = (m: string) => new PmError("invalid-input", m, 1);
export const notRegistered = (m: string) => new PmError("not-registered", m, 2);
export const dependencyFailure = (m: string) => new PmError("dependency-failure", m, 3);
export const insufficientBudget = (m: string) => new PmError("insufficient-budget", m, 4);
export const capacity = (m: string) => new PmError("capacity", m, 5);
export const staleRevision = (m: string) => new PmError("stale-revision", m, 6);

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function newGeneration(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Atomic file replacement: write temp in same directory, fsync-free rename. */
export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.tmp-${randomUUID()}`);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

/** OS user-data directory for this tool, overridable for tests via PM_HOME. */
export function pmHome(): string {
  const env = process.env.PM_HOME;
  if (env) return env;
  const home = process.env.HOME;
  if (!home) return join(tmpdir(), "project-memory");
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "project-memory");
  }
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg ?? join(home, ".local", "share"), "project-memory");
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // best effort on platforms without POSIX modes
  }
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Truncate a string so its UTF-8 form fits maxBytes; returns [text, truncated]. */
export function truncateUtf8(s: string, maxBytes: number): [string, boolean] {
  if (utf8Bytes(s) <= maxBytes) return [s, false];
  const buf = Buffer.from(s, "utf8").subarray(0, maxBytes);
  // avoid splitting a multibyte character
  let text = buf.toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
  if (text.endsWith("�")) text = text.slice(0, -1);
  return [text, true];
}
