import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve, isAbsolute, relative } from "node:path";
import { existsSync } from "node:fs";
import type { Project } from "./project.ts";
import { LIMITS } from "./util.ts";

/**
 * Narrow adapter around the pinned @zvec/zvec-grep public library, run in an
 * owned worker process so timeout/cancellation can terminate it. Lexical (rg)
 * route only; vector retrieval stays blocked until upstream offers a verified
 * offline model contract. Failures degrade to a typed reason — retrieval never
 * implicitly rebuilds an index, downloads a model or sends anything remotely.
 */

export type ZvecDiscovery = {
  paths: string[]; // root-relative, containment-validated
  status: string; // typed coverage statement
};

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "workers", "zvec-worker.ts");

function zvecAvailable(): boolean {
  // resolve without importing (import would load heavy deps into this process)
  const req = resolve(process.cwd(), "node_modules", "@zvec", "zvec-grep", "package.json");
  if (existsSync(req)) return true;
  const local = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@zvec", "zvec-grep", "package.json");
  return existsSync(local);
}

export function zvecDiscover(project: Project, query: string): ZvecDiscovery {
  if (!zvecAvailable()) {
    return { paths: [], status: "degraded: zvec-grep not installed; FTS-only retrieval" };
  }
  const req = JSON.stringify({
    root: project.identity.root,
    query,
    limit: LIMITS.zvecMaxResults,
    mode: "search",
  });
  const res = spawnSync(process.execPath, [WORKER, req], {
    encoding: "utf8",
    timeout: LIMITS.zvecWorkerTimeoutMs,
    maxBuffer: 4 * 1024 * 1024, // bounded worker output channel
    env: { ...process.env },
    killSignal: "SIGKILL",
  });
  if (res.error || res.status !== 0) {
    const reason = res.error ? String(res.error.message) : `worker exit ${res.status}`;
    return { paths: [], status: `degraded: zvec worker failed (${reason}); FTS-only retrieval` };
  }
  let parsed: { ok: boolean; items?: { absolutePath: string | null; relativePath: string | null }[]; root?: string; error?: string };
  try {
    parsed = JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    return { paths: [], status: "degraded: zvec worker returned malformed output; FTS-only retrieval" };
  }
  if (!parsed.ok) {
    return { paths: [], status: `degraded: zvec error (${parsed.error ?? "unknown"}); FTS-only retrieval` };
  }
  // A changed returned root invalidates the semantic portion of the result.
  if (parsed.root !== project.identity.root) {
    return { paths: [], status: "degraded: zvec returned an unexpected root; result rejected" };
  }
  const root = project.identity.root;
  const paths: string[] = [];
  for (const it of parsed.items ?? []) {
    const abs = it.absolutePath ?? (it.relativePath ? resolve(root, it.relativePath) : null);
    if (!abs || !isAbsolute(abs)) continue;
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue; // containment validation
    paths.push(rel.split("\\").join("/"));
  }
  return {
    paths: [...new Set(paths)].slice(0, LIMITS.zvecMaxResults),
    status: "lexical discovery via zvec rg route (autoUpdate=false); vector retrieval blocked pending offline enforcement upstream",
  };
}

export type IndexResult = {
  supported: false;
  reason: string;
};

/**
 * `pm index`: explicit synchronous maintenance. Building the semantic index
 * requires acquiring a local embedding model with verified digest/completeness
 * and an enforced no-download retrieval runtime — the pinned zvec release
 * (0.2.1) has no public offline/preflight contract, so this stays blocked
 * rather than shipping an undocumented guarantee.
 */
export function zvecIndex(_project: Project): IndexResult {
  return {
    supported: false,
    reason:
      "semantic index maintenance is blocked: @zvec/zvec-grep@0.2.1 exposes no offline/no-download model contract (design stage-0 gate). Lexical retrieval (rg route + SQLite FTS) is active and needs no index.",
  };
}
