import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { LIMITS, dependencyFailure } from "./util.ts";

/**
 * Hardened read-only Git evidence commands:
 * - fixed argument arrays, literal pathspecs
 * - replacement-object interpretation and lazy fetch disabled on every call
 * - user/system config, external diff/pager/fsmonitor helpers excluded
 * - all GIT_* environment overrides stripped
 * - bounded output and timeout
 */
const HARDENED_PREFIX = [
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--literal-pathspecs",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_")) continue;
    env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export type GitResult = { ok: boolean; stdout: string; stderr: string; code: number };

export function runGit(cwd: string, args: string[], timeoutMs = 5_000): GitResult {
  const res = spawnSync("git", [...HARDENED_PREFIX, ...args], {
    cwd,
    env: sanitizedEnv(),
    encoding: "utf8",
    maxBuffer: LIMITS.maxGitOutputBytes,
    timeout: timeoutMs,
  });
  if (res.error) {
    return { ok: false, stdout: "", stderr: String(res.error.message), code: -1 };
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
}

export type GitLayout = {
  isRepo: boolean;
  gitDir?: string;
  commonDir?: string;
  toplevel?: string;
  objectFormat?: string;
  head?: string; // commit OID, undefined when unborn/detached-unborn
  enrichmentDisabled?: string; // reason git evidence is disabled
};

/**
 * Inspect repository layout and admit it for evidence reads. Nonempty object
 * alternates or unapproved storage redirections disable Git enrichment (the
 * memory core still works; history is reported incomplete).
 */
export function inspectGitLayout(root: string): GitLayout {
  const rp = runGit(root, [
    "rev-parse",
    "--is-inside-work-tree",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel",
  ]);
  if (!rp.ok) return { isRepo: false };
  const lines = rp.stdout.trim().split("\n");
  if (lines[0] !== "true" || lines.length < 4) return { isRepo: false };
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  const gitDir = abs(lines[1]!);
  const commonDir = abs(lines[2]!);
  const toplevel = lines[3]!;

  const layout: GitLayout = { isRepo: true, gitDir, commonDir, toplevel };

  const fmt = runGit(root, ["rev-parse", "--show-object-format"]);
  layout.objectFormat = fmt.ok ? fmt.stdout.trim() : "sha1";

  const head = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  if (head.ok) layout.head = head.stdout.trim();

  // Reject nonempty object alternates and non-directory object stores.
  const alternates = join(commonDir, "objects", "info", "alternates");
  if (existsSync(alternates)) {
    const content = readFileSync(alternates, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    if (content.length > 0) {
      layout.enrichmentDisabled = "object alternates present; unapproved storage redirection";
    }
  }
  const objects = join(commonDir, "objects");
  try {
    const st = lstatSync(objects);
    if (st.isSymbolicLink()) {
      layout.enrichmentDisabled = "object store is a symlink; unapproved storage redirection";
    }
  } catch {
    // no object dir: treated as unborn/empty
  }
  return layout;
}

/** Re-validate that admitted layout has not changed; returns reason if changed. */
export function revalidateLayout(root: string, admitted: GitLayout): string | undefined {
  const now = inspectGitLayout(root);
  if (!admitted.isRepo) return now.isRepo ? "repository appeared after admission" : undefined;
  if (!now.isRepo) return "repository disappeared";
  if (now.enrichmentDisabled) return now.enrichmentDisabled;
  if (now.commonDir !== admitted.commonDir) return "git common directory changed";
  if (now.objectFormat !== admitted.objectFormat) return "object format changed";
  return undefined;
}

export function headOid(root: string): string | undefined {
  const r = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  return r.ok ? r.stdout.trim() : undefined;
}

export function blobOidAtHead(root: string, relPath: string): string | undefined {
  const r = runGit(root, ["rev-parse", "--verify", `HEAD:${relPath}`]);
  return r.ok ? r.stdout.trim() : undefined;
}

export function isFileDirty(root: string, relPath: string): boolean {
  const r = runGit(root, ["status", "--porcelain", "--", relPath]);
  return !r.ok || r.stdout.trim().length > 0;
}

export function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  const r = runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return r.ok;
}

export type GitLogEntry = { oid: string; date: string; subject: string };

/** Bounded per-file history window; historical clues only. */
export function fileHistory(root: string, relPath: string, limit: number = LIMITS.maxGitHistoryWindow): GitLogEntry[] {
  const r = runGit(root, [
    "log",
    `--max-count=${limit}`,
    "--format=%H%x1f%cI%x1f%s",
    "--",
    relPath,
  ]);
  if (!r.ok) return [];
  return r.stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [oid = "", date = "", subject = ""] = l.split("\x1f");
      return { oid, date, subject };
    });
}

export function commitExists(root: string, oid: string): boolean {
  const r = runGit(root, ["cat-file", "-e", `${oid}^{commit}`]);
  return r.ok;
}

export function gitVersionSupportsRequiredFlags(): boolean {
  const res = spawnSync("git", ["--no-replace-objects", "--no-lazy-fetch", "version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return res.status === 0;
}

export function requireGitOrDisable(root: string): GitLayout {
  if (!gitVersionSupportsRequiredFlags()) {
    throw dependencyFailure(
      "installed git lacks required --no-replace-objects/--no-lazy-fetch controls; Git evidence disabled",
    );
  }
  return inspectGitLayout(root);
}
