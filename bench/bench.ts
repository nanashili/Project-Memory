/**
 * Retrieval latency benchmark. Measures:
 *  - warm library-level exact lookup (pm why path)   — design target p95 < 100 ms
 *  - warm library-level task packet (pm context)     — design target p95 < 750 ms
 *  - CLI process-level equivalents (includes Node startup; real-world cost)
 *
 * Token/correctness comparison vs zvec-grep alone requires paired live agent
 * tasks and is NOT measured here (labeled unmeasured in RESULTS).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openProject } from "../src/lib/project.ts";
import { assembleContext } from "../src/lib/context.ts";
import { whyAt } from "../src/lib/queries.ts";

const CLI = join(fileURLToPath(import.meta.url), "..", "..", "src", "cli.ts");
const pmHome = mkdtempSync(join(tmpdir(), "pm-bench-home-"));
process.env.PM_HOME = pmHome; // in-process library calls use the same isolated home
const dir = mkdtempSync(join(tmpdir(), "pm-bench-proj-"));

function sh(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PM_HOME: pmHome, GIT_AUTHOR_NAME: "b", GIT_AUTHOR_EMAIL: "b@b", GIT_COMMITTER_NAME: "b", GIT_COMMITTER_EMAIL: "b@b" },
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// --- fixture: git project with N files, imported session, D decisions
const FILES = 50;
const DECISIONS = 40;
const EVENTS = 200;

mkdirSync(join(dir, "src"), { recursive: true });
for (let i = 0; i < FILES; i++) {
  writeFileSync(
    join(dir, "src", `mod${i}.ts`),
    `export function fn${i}(n: number) {\n  // module ${i} bounded work\n  return Math.min(n, ${i});\n}\n`,
  );
}
sh("git", ["init", "-q", "."], dir);
sh("git", ["add", "-A"], dir);
sh("git", ["commit", "-qm", "fixture"], dir);

sh(process.execPath, [CLI, "init", "--path", dir, "--json"]);
const root = JSON.parse(sh(process.execPath, [CLI, "status", "--path", dir, "--json"])).root as string;

const transcript: object[] = [{ type: "header", adapter: "generic", session: "bench" }];
for (let i = 0; i < EVENTS; i++) {
  transcript.push({
    type: "event",
    event_id: `e${i}`,
    role: i % 2 ? "assistant" : "user",
    content: `discussion about module ${i % FILES}: retries, allowances, timeouts and budgets, message ${i}`,
  });
}
const tPath = join(dir, "bench.jsonl");
writeFileSync(tPath, transcript.map((l) => JSON.stringify(l)).join("\n"));
const t0 = performance.now();
sh(process.execPath, [CLI, "capture", "import", "--adapter", "generic", "--input", tPath, "--path", root, "--json"]);
const importMs = performance.now() - t0;

for (let i = 0; i < DECISIONS; i++) {
  sh(process.execPath, [
    CLI, "decisions", "add", "--path", root,
    "--proposition", `Module ${i % FILES} caps its parameter at ${i}`,
    "--rationale", `bounded work allowance for module ${i % FILES}`,
    "--scope-kind", "file", "--scope-value", `src/mod${i % FILES}.ts`,
    "--source-code", `src/mod${i % FILES}.ts:1:4`,
    "--json",
  ]);
}

function stats(samples: number[]): { p50: number; p95: number; mean: number } {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { p50: q(0.5), p95: q(0.95), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

// --- warm library-level
const project = openProject(root);
const ITER = 100;
const whySamples: number[] = [];
for (let i = 0; i < ITER; i++) {
  const a = performance.now();
  whyAt(project, `src/mod${i % FILES}.ts`, 2);
  whySamples.push(performance.now() - a);
}
const ctxSamples: number[] = [];
for (let i = 0; i < ITER; i++) {
  const a = performance.now();
  assembleContext(project, {
    task: `change bounded work in module ${i % FILES}`,
    file: `src/mod${i % FILES}.ts`,
    lineStart: 1,
    lineEnd: 4,
    maxBytes: 8192,
  });
  ctxSamples.push(performance.now() - a);
}
project.db.close();

// --- CLI process-level (includes Node startup + TS stripping)
const CLI_ITER = 20;
const cliWhy: number[] = [];
for (let i = 0; i < CLI_ITER; i++) {
  const a = performance.now();
  sh(process.execPath, [CLI, "why", `src/mod${i % FILES}.ts:2`, "--path", root, "--json"]);
  cliWhy.push(performance.now() - a);
}
const cliCtx: number[] = [];
for (let i = 0; i < CLI_ITER; i++) {
  const a = performance.now();
  sh(process.execPath, [CLI, "context", "--task", `module ${i % FILES} bounds`, "--file", `src/mod${i % FILES}.ts`, "--path", root, "--no-zvec"]);
  cliCtx.push(performance.now() - a);
}
// context with zvec lexical discovery (worker spawn per request)
const cliCtxZvec: number[] = [];
for (let i = 0; i < 5; i++) {
  const a = performance.now();
  sh(process.execPath, [CLI, "context", "--task", `module ${i % FILES} bounds`, "--path", root]);
  cliCtxZvec.push(performance.now() - a);
}

const fmt = (s: { p50: number; p95: number; mean: number }) =>
  `p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, mean ${s.mean.toFixed(1)} ms`;

console.log(JSON.stringify({
  fixture: { files: FILES, events: EVENTS, decisions: DECISIONS, importMs: Number(importMs.toFixed(1)) },
  warmLibrary: {
    exactLookup_why: fmt(stats(whySamples)),
    taskPacket_context: fmt(stats(ctxSamples)),
    iterations: ITER,
    designTargets: { exactLookup: "p95 < 100 ms", taskPacket: "p95 < 750 ms (excl. model inference)" },
  },
  cliProcess: {
    why: fmt(stats(cliWhy)),
    context_noZvec: fmt(stats(cliCtx)),
    context_withZvecLexicalWorker: fmt(stats(cliCtxZvec)),
    iterations: CLI_ITER,
    note: "includes Node startup and TS type-stripping per invocation",
  },
  unmeasured: [
    "total workflow tokens vs zvec-grep alone (requires paired live agent tasks)",
    "task correctness comparison (requires paired live agent tasks)",
    "cold-start model loading (vector retrieval is blocked upstream)",
  ],
}, null, 2));
