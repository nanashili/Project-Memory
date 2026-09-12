#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PmError, invalid, LIMITS, utf8Bytes } from "./lib/util.ts";
import { initProject, openProject, purgeProject, type Project } from "./lib/project.ts";
import { getMeta, dbSizeBytes } from "./lib/db.ts";
import { ingestBatch } from "./lib/ingest.ts";
import {
  addDecision,
  proposeDecisions,
  confirmDecision,
  rejectDecision,
  supersedeDecision,
  reviseDecision,
  getCurrentRevision,
  type DecisionInput,
  type SourceInput,
} from "./lib/decisions.ts";
import { assembleContext } from "./lib/context.ts";
import { whyAt, searchMemory, inspectDecision, historyForFile, exportMemory } from "./lib/queries.ts";
import { previewForgetSession, forgetSession, forgetDecision } from "./lib/forget.ts";
import { backupProject, restoreProject } from "./lib/backup.ts";
import { captureSetup, captureStatus, validateBinding } from "./lib/capture.ts";
import { zvecDiscover, zvecIndex } from "./lib/zvec.ts";
import { safeReadSelectedFile } from "./lib/safeio.ts";
import { gitVersionSupportsRequiredFlags, inspectGitLayout } from "./lib/git.ts";
import { genericAdapter } from "./adapters/generic.ts";
import { claudeCodeAdapter } from "./adapters/claudeCode.ts";
import { codexAdapter } from "./adapters/codex.ts";
import { cursorAdapter } from "./adapters/cursor.ts";
import type { Adapter } from "./adapters/types.ts";
import { sha256Hex } from "./lib/util.ts";

const ADAPTERS: Record<string, Adapter> = {
  generic: genericAdapter,
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
};

type Args = { positional: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function str(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function num(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw invalid(`--${name} must be a number`);
  return n;
}

function requireStr(flags: Record<string, string | boolean>, name: string): string {
  const v = str(flags, name);
  if (!v) throw invalid(`missing required --${name}`);
  return v;
}

/** stdout is machine-readable only; human diagnostics go to stderr. */
function emit(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ schema: 1, ...(result as object) }) + "\n");
  } else {
    process.stdout.write(renderHuman(result) + "\n");
  }
}

function renderHuman(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

function projectFor(flags: Record<string, string | boolean>): Project {
  return openProject(resolve(str(flags, "path") ?? process.cwd()));
}

function parseFileLines(flags: Record<string, string | boolean>): {
  file?: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const file = str(flags, "file");
  const lines = str(flags, "lines");
  if (!lines) return file ? { file } : {};
  if (!file) throw invalid("--lines requires --file");
  const m = /^(\d+):(\d+)$/.exec(lines);
  if (!m) throw invalid("--lines must be start:end");
  return { file, lineStart: Number(m[1]), lineEnd: Number(m[2]) };
}

function collectSources(flags: Record<string, string | boolean>, argv: string[]): SourceInput[] {
  // repeated flags: parse raw argv for --source-event / --source-code / --source-note
  const sources: SourceInput[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = argv[i + 1];
    if (a === "--source-event" && val) {
      const m = /^([^:]+)(?::(\d+):(\d+))?$/.exec(val);
      if (!m) throw invalid("--source-event must be <event-id>[:spanStart:spanEnd]");
      sources.push({
        kind: "event",
        eventId: m[1]!,
        ...(m[2] ? { spanStart: Number(m[2]), spanEnd: Number(m[3]) } : {}),
      });
      i++;
    } else if (a === "--source-code" && val) {
      const m = /^(.+):(\d+):(\d+)$/.exec(val);
      if (!m) throw invalid("--source-code must be <file>:<lineStart>:<lineEnd>");
      sources.push({ kind: "code", file: m[1]!, lineStart: Number(m[2]), lineEnd: Number(m[3]) });
      i++;
    } else if (a === "--source-note" && val) {
      sources.push({ kind: "manual", note: val });
      i++;
    }
  }
  void flags;
  return sources;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const json = flags.json === true;
  const cmd = positional[0];

  switch (cmd) {
    case "init": {
      const root = resolve(str(flags, "path") ?? process.cwd());
      const r = initProject(root);
      emit({ kind: "init", ...r, captureEnabled: false, indexEnabled: false }, json);
      return;
    }

    case "status": {
      const p = projectFor(flags);
      try {
        const sessions = p.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
        const events = p.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
        const decisions = p.db
          .prepare(
            "SELECT COUNT(*) AS c FROM decisions WHERE current_revision_id IS NOT NULL",
          )
          .get() as { c: number };
        const gaps = p.db
          .prepare("SELECT COUNT(*) AS c FROM coverage WHERE status != 'complete'")
          .get() as { c: number };
        const conflicts = p.db.prepare("SELECT COUNT(*) AS c FROM conflicts").get() as { c: number };
        emit(
          {
            kind: "status",
            projectId: p.identity.projectId,
            root: p.identity.root,
            generation: p.identity.generation,
            lifecycle: p.identity.lifecycle,
            git: p.git.isRepo
              ? {
                  head: p.git.head ?? null,
                  objectFormat: p.git.objectFormat,
                  enrichment: p.git.enrichmentDisabled ?? "enabled",
                }
              : { enrichment: "not a git repository" },
            sessions: sessions.c,
            events: events.c,
            activeDecisions: decisions.c,
            coverageGaps: gaps.c,
            replayConflicts: conflicts.c,
            dbBytes: dbSizeBytes(p.db),
            quotaBytes: Number(getMeta(p.db, "quota_bytes")),
            captureBindings: captureStatus(p),
            semanticIndex: "blocked (offline enforcement unavailable upstream); lexical retrieval active",
          },
          json,
        );
      } finally {
        p.db.close();
      }
      return;
    }

    case "index": {
      const p = projectFor(flags);
      try {
        emit({ kind: "index", ...zvecIndex(p) }, json);
      } finally {
        p.db.close();
      }
      return;
    }

    case "capture": {
      const sub = positional[1];
      if (sub === "setup") {
        const host = positional[2];
        if (!host) throw invalid("usage: pm capture setup <claude-code|codex|cursor>");
        const p = projectFor(flags);
        try {
          emit({ kind: "capture-setup", ...captureSetup(p, host) }, json);
        } finally {
          p.db.close();
        }
        return;
      }
      if (sub === "status") {
        const p = projectFor(flags);
        try {
          emit({ kind: "capture-status", bindings: captureStatus(p) }, json);
        } finally {
          p.db.close();
        }
        return;
      }
      if (sub === "import") {
        const adapterName = requireStr(flags, "adapter");
        const adapter = ADAPTERS[adapterName];
        if (!adapter) throw invalid(`unknown adapter '${adapterName}'; supported: ${Object.keys(ADAPTERS).join(", ")}`);
        const input = resolve(requireStr(flags, "input"));
        const p = projectFor(flags);
        try {
          const binding = str(flags, "binding");
          if (binding) validateBinding(p, adapterName, binding);
          const read = safeReadSelectedFile(input, LIMITS.maxImportFileBytes);
          const sourceIdentity = `file:${input}:${sha256Hex(read.content).slice(0, 16)}`;
          const parsed = adapter.parse(read.content, sourceIdentity);
          const report = ingestBatch(p, parsed.spec, parsed.events, {
            coverageStatus: parsed.coverageStatus,
          });
          for (const w of parsed.warnings) process.stderr.write(`warning: ${w}\n`);
          emit({ kind: "capture-import", adapter: adapterName, ...report, warnings: parsed.warnings }, json);
        } finally {
          p.db.close();
        }
        return;
      }
      throw invalid("usage: pm capture <import|setup|status>");
    }

    case "decisions": {
      const sub = positional[1];
      const p = projectFor(flags);
      try {
        if (sub === "add") {
          const sources = collectSources(flags, argv);
          const input: DecisionInput = {
            proposition: requireStr(flags, "proposition"),
            rationale: str(flags, "rationale"),
            alternatives: str(flags, "alternatives"),
            constraintsNote: str(flags, "constraints"),
            scopeKind: (str(flags, "scope-kind") ?? "project") as DecisionInput["scopeKind"],
            scopeValue: str(flags, "scope-value") ?? "",
            sources: sources.length > 0 ? sources : [{ kind: "manual", note: "developer-entered without linked evidence" }],
          };
          const r = addDecision(p, input, "developer");
          emit({ kind: "decision-added", ...r, authority: "confirmed", rev: 1 }, json);
        } else if (sub === "propose") {
          const inputPath = requireStr(flags, "input");
          const requestId = requireStr(flags, "request-id");
          const raw =
            inputPath === "-" ? readFileSync(0, "utf8") : safeReadSelectedFile(resolve(inputPath), 4 * 1024 * 1024).content;
          const proposals = JSON.parse(raw) as DecisionInput[];
          if (!Array.isArray(proposals)) throw invalid("proposal input must be a JSON array of decisions");
          const r = proposeDecisions(p, requestId, proposals);
          emit({ kind: "decisions-proposed", ...r, authority: "candidate", note: "candidates require developer confirmation via pm decisions confirm" }, json);
        } else if (sub === "confirm") {
          const id = positional[2];
          if (!id) throw invalid("usage: pm decisions confirm <decision-id> --expected-revision N");
          const rev = num(flags, "expected-revision");
          if (rev === undefined) throw invalid("missing required --expected-revision");
          const r = confirmDecision(p, id, rev);
          emit({ kind: "decision-confirmed", decisionId: id, rev: r.rev, authority: r.authority }, json);
        } else if (sub === "reject") {
          const id = positional[2];
          if (!id) throw invalid("usage: pm decisions reject <decision-id> --expected-revision N");
          const rev = num(flags, "expected-revision");
          if (rev === undefined) throw invalid("missing required --expected-revision");
          rejectDecision(p, id, rev);
          emit({ kind: "decision-rejected", decisionId: id }, json);
        } else if (sub === "supersede") {
          const oldId = positional[2];
          if (!oldId) throw invalid("usage: pm decisions supersede <old-id> --expected-revision N --with <new-id> --with-expected-revision M");
          const oldRev = num(flags, "expected-revision");
          const newId2 = requireStr(flags, "with");
          const newRev = num(flags, "with-expected-revision");
          if (oldRev === undefined || newRev === undefined) {
            throw invalid("supersede requires --expected-revision and --with-expected-revision");
          }
          const r = supersedeDecision(p, oldId, oldRev, newId2, newRev);
          emit({ kind: "decision-superseded", oldDecision: oldId, newDecision: newId2, ...r }, json);
        } else if (sub === "revise") {
          const id = positional[2];
          if (!id) throw invalid("usage: pm decisions revise <decision-id> --expected-revision N [--proposition ...]");
          const rev = num(flags, "expected-revision");
          if (rev === undefined) throw invalid("missing required --expected-revision");
          const r = reviseDecision(p, id, rev, {
            proposition: str(flags, "proposition"),
            rationale: str(flags, "rationale"),
            scopeKind: str(flags, "scope-kind") as DecisionInput["scopeKind"] | undefined,
            scopeValue: str(flags, "scope-value"),
          });
          emit({ kind: "decision-revised", decisionId: id, ...r, authority: "candidate", note: "edit created an unconfirmed revision; confirm it explicitly" }, json);
        } else if (sub === "show") {
          const id = positional[2];
          if (!id) throw invalid("usage: pm decisions show <decision-id>");
          const r = getCurrentRevision(p.db, id);
          emit({ kind: "decision", ...r }, json);
        } else {
          throw invalid("usage: pm decisions <add|propose|confirm|reject|supersede|revise|show>");
        }
      } finally {
        p.db.close();
      }
      return;
    }

    case "context": {
      const p = projectFor(flags);
      try {
        const { file, lineStart, lineEnd } = parseFileLines(flags);
        const task = str(flags, "task");
        const maxBytes = num(flags, "max-bytes") ?? (task || file ? LIMITS.defaultTaskPacketBytes : LIMITS.defaultOrientationBytes);
        let zvecPaths: string[] | undefined;
        let zvecStatus: string | undefined;
        if (task && flags["no-zvec"] !== true) {
          const d = zvecDiscover(p, task);
          zvecPaths = d.paths;
          zvecStatus = d.status;
        }
        const packet = assembleContext(p, { task, file, lineStart, lineEnd, maxBytes, zvecPaths, zvecStatus });
        const out = JSON.stringify(packet);
        if (utf8Bytes(out) > maxBytes) throw invalid("internal: packet exceeded budget after enforcement");
        process.stdout.write(out + "\n");
      } finally {
        p.db.close();
      }
      return;
    }

    case "why": {
      const loc = positional[1];
      if (!loc) throw invalid("usage: pm why <file>:<line>");
      const m = /^(.+):(\d+)$/.exec(loc);
      if (!m) throw invalid("usage: pm why <file>:<line>");
      const p = projectFor(flags);
      try {
        const results = whyAt(p, m[1]!, Number(m[2]));
        emit(
          {
            kind: "why",
            location: loc,
            results,
            answer:
              results.length > 0
                ? "recorded-decision"
                : "unknown-rationale (no sufficient recorded explanation; try pm history --file for historical clues)",
          },
          json,
        );
      } finally {
        p.db.close();
      }
      return;
    }

    case "search": {
      const q = positional[1];
      if (!q) throw invalid('usage: pm search "<query>"');
      const p = projectFor(flags);
      try {
        emit({ kind: "search", query: q, ...searchMemory(p, q) }, json);
      } finally {
        p.db.close();
      }
      return;
    }

    case "inspect": {
      const id = positional[1];
      if (!id) throw invalid("usage: pm inspect <decision-id> [--sources]");
      const p = projectFor(flags);
      try {
        emit({ kind: "inspect", ...inspectDecision(p, id, flags.sources === true) }, json);
      } finally {
        p.db.close();
      }
      return;
    }

    case "history": {
      const file = requireStr(flags, "file");
      const p = projectFor(flags);
      try {
        emit({ kind: "history", ...historyForFile(p, file) }, json);
      } finally {
        p.db.close();
      }
      return;
    }

    case "export": {
      const output = requireStr(flags, "output");
      const p = projectFor(flags);
      try {
        if (existsSync(output)) throw invalid(`refusing to overwrite existing export: ${output}`);
        const lines = exportMemory(p);
        writeFileSync(output, lines.join("\n") + "\n", { mode: 0o600 });
        emit({ kind: "export", output, records: lines.length, note: "export is a private copy; deleting memory later does not delete it" }, json);
      } finally {
        p.db.close();
      }
      return;
    }

    case "forget": {
      const session = str(flags, "session");
      const decision = str(flags, "decision");
      if (!session && !decision) throw invalid("usage: pm forget --session <id> | --decision <id> [--preview|--yes]");
      const p = projectFor(flags);
      try {
        if (flags.preview === true || flags.yes !== true) {
          const preview = session
            ? previewForgetSession(p, session)
            : { sessions: 0, events: 0, decisionsRemoved: [decision!], markersRetained: [], boundaries: [] };
          emit({ kind: "forget-preview", ...preview, note: "re-run with --yes to execute" }, json);
          return;
        }
        const r = session ? forgetSession(p, session) : forgetDecision(p, decision!);
        emit({ kind: "forget", ...r }, json);
      } finally {
        p.db.close();
      }
      return;
    }

    case "backup": {
      const output = requireStr(flags, "output");
      const root = resolve(str(flags, "path") ?? process.cwd());
      const manifest = await backupProject(root, resolve(output));
      emit({ kind: "backup", output: resolve(output), ...manifest }, json);
      return;
    }

    case "restore": {
      const input = requireStr(flags, "input");
      const root = resolve(str(flags, "path") ?? process.cwd());
      if (flags.yes !== true) {
        emit({ kind: "restore-preview", note: "restore replaces current memory with the snapshot, retires the current generation and disables capture. Re-run with --yes." }, json);
        return;
      }
      const r = await restoreProject(root, resolve(input));
      emit({ kind: "restore", ...r }, json);
      return;
    }

    case "purge": {
      const root = resolve(str(flags, "path") ?? process.cwd());
      if (flags.yes !== true) {
        emit({ kind: "purge-preview", note: "purge deletes the project's memory database and retires its generation. Re-run with --yes." }, json);
        return;
      }
      const r = purgeProject(root);
      emit({ kind: "purge", ...r }, json);
      return;
    }

    case "doctor": {
      const root = resolve(str(flags, "path") ?? process.cwd());
      const checks: Record<string, unknown> = {};
      checks.node = process.version;
      const { DatabaseSync } = await import("node:sqlite");
      const mem = new DatabaseSync(":memory:");
      checks.sqlite = (mem.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
      try {
        mem.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
        checks.fts5 = true;
      } catch {
        checks.fts5 = false;
      }
      mem.close();
      checks.gitHardenedFlags = gitVersionSupportsRequiredFlags();
      const layout = inspectGitLayout(root);
      checks.gitRepo = layout.isRepo;
      if (layout.enrichmentDisabled) checks.gitEnrichment = `disabled: ${layout.enrichmentDisabled}`;
      let registered = false;
      try {
        const p = openProject(root);
        registered = true;
        checks.projectId = p.identity.projectId;
        checks.schemaOk = true;
        checks.integrity = (p.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
          .integrity_check;
        p.db.close();
      } catch (e) {
        checks.project = e instanceof PmError ? `${e.code}: ${e.message}` : String(e);
      }
      checks.registered = registered;
      checks.semanticIndex = "blocked (no offline model contract upstream); lexical retrieval active";
      emit({ kind: "doctor", checks }, json);
      return;
    }

    default:
      process.stderr.write(
        `pm — project memory CLI
usage:
  pm init [--path P]
  pm status [--path P] [--json]
  pm index
  pm capture setup <claude-code|codex|cursor>
  pm capture import --adapter <generic|claude-code|codex|cursor> --input <file> [--binding B]
  pm capture status
  pm decisions add --proposition "..." [--rationale ...] [--scope-kind file --scope-value src/x.ts] [--source-event E[:s:e]] [--source-code f:l1:l2] [--source-note ...]
  pm decisions propose --input <file|-> --request-id <id>
  pm decisions confirm <D> --expected-revision N
  pm decisions reject <D> --expected-revision N
  pm decisions supersede <D-old> --expected-revision N --with <D-new> --with-expected-revision M
  pm decisions revise <D> --expected-revision N [--proposition ...]
  pm context [--task "..."] [--file F --lines a:b] [--max-bytes N] [--no-zvec]
  pm why <file>:<line>
  pm search "<query>"
  pm inspect <D> [--sources]
  pm history --file F
  pm export --output f.jsonl
  pm forget --session <S> | --decision <D> [--preview|--yes]
  pm backup --output f.db / pm restore --input f.db --yes
  pm purge --yes
  pm doctor
`,
      );
      process.exitCode = cmd ? 1 : 0;
      return;
  }
}

main().catch((e: unknown) => {
  if (e instanceof PmError) {
    process.stderr.write(`error (${e.code}): ${e.message}\n`);
    process.stdout.write(JSON.stringify({ schema: 1, kind: "error", code: e.code, message: e.message }) + "\n");
    process.exitCode = e.exitCode;
  } else {
    process.stderr.write(`unexpected error: ${String((e as Error)?.stack ?? e)}\n`);
    process.exitCode = 70;
  }
});
