import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { run, makeEnv, makeGitProject, writeTranscript } from "./helpers.ts";
import { claudeCodeAdapter } from "../src/adapters/claudeCode.ts";
import { codexAdapter } from "../src/adapters/codex.ts";
import { cursorAdapter } from "../src/adapters/cursor.ts";

function openProjectDb(pmHome: string): DatabaseSync {
  const projects = readdirSync(join(pmHome, "projects"));
  return new DatabaseSync(join(pmHome, "projects", projects[0]!, "memory.db"), { readOnly: true });
}

test("claude-code: forks create isolated lineages; approval cannot cross them", () => {
  // u1 -> a1 -> u2a (main) and u1 -> a1 -> u2b (fork after edit/resume)
  const lines = [
    { type: "user", uuid: "u1", parentUuid: null, sessionId: "cc-f", message: { role: "user", content: "cap retries at 3" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "cc-f", message: { role: "assistant", content: [{ type: "text", text: "ok, capping at 3" }] } },
    { type: "user", uuid: "u2a", parentUuid: "a1", sessionId: "cc-f", message: { role: "user", content: "yes, approved" } },
    { type: "user", uuid: "u2b", parentUuid: "a1", sessionId: "cc-f", message: { role: "user", content: "no, make it 5 instead" } },
  ];
  const parsed = claudeCodeAdapter.parse(lines.map((l) => JSON.stringify(l)).join("\n"), "test");
  assert.equal(parsed.spec.sourceSession, "cc-f");
  const byId = new Map(parsed.events.map((e) => [e.sourceEvent, e]));
  const mainLineage = byId.get("u1")!.lineage;
  assert.equal(byId.get("a1")!.lineage, mainLineage);
  assert.equal(byId.get("u2a")!.lineage, mainLineage, "first child continues main lineage");
  assert.notEqual(byId.get("u2b")!.lineage, mainLineage, "fork starts an isolated lineage");
  assert.ok(parsed.warnings.some((w) => w.includes("fork")));
});

test("claude-code: thinking blocks and unknown types are discarded; tool events bounded", () => {
  const lines = [
    {
      type: "assistant", uuid: "a1", parentUuid: null, sessionId: "cc-t",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET-REASONING-DO-NOT-RETAIN" },
          { type: "text", text: "visible answer" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "future_unknown_block", text: "UNKNOWN-FIELD-TEXT" },
        ],
      },
    },
    { type: "user", uuid: "u2", parentUuid: "a1", sessionId: "cc-t", message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "file1 file2" }] }] } },
  ];
  const parsed = claudeCodeAdapter.parse(lines.map((l) => JSON.stringify(l)).join("\n"), "test");
  const all = parsed.events.map((e) => e.content).join("\n");
  assert.ok(!all.includes("SECRET-REASONING"), "thinking never retained");
  assert.ok(!all.includes("UNKNOWN-FIELD-TEXT"), "unknown block types never retained");
  assert.ok(all.includes("visible answer"));
  assert.ok(parsed.events.some((e) => e.role === "tool_input" && e.content.includes("[tool:Bash]")));
  assert.ok(parsed.events.some((e) => e.role === "tool_result" && e.content.includes("file1")));
});

test("claude-code: unknown ancestry becomes unverified isolated lineage", () => {
  const lines = [
    { type: "user", uuid: "u9", parentUuid: "missing-parent", sessionId: "cc-u", message: { role: "user", content: "resumed from unknown state" } },
  ];
  const parsed = claudeCodeAdapter.parse(lines.map((l) => JSON.stringify(l)).join("\n"), "test");
  assert.equal(parsed.coverageStatus, "unverified");
  assert.ok(parsed.events[0]!.lineage.includes("root-u9"));
  assert.equal(parsed.events[0]!.meta?.unverified_ancestry, true);
});

test("claude-code end-to-end import via CLI stores lineage-scoped events", () => {
  const { pmHome } = makeEnv();
  const dir = makeGitProject("ccimport");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  const root = init.json!.root as string;
  const lines = [
    { type: "user", uuid: "u1", parentUuid: null, sessionId: "cc-e2e", message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "cc-e2e", message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "thinking", thinking: "HIDDEN" }] } },
    { type: "user", uuid: "u2b", parentUuid: "u1", sessionId: "cc-e2e", message: { role: "user", content: "fork branch message" } },
  ];
  const t = writeTranscript(root, "cc.jsonl", lines);
  const imp = run(pmHome, ["capture", "import", "--adapter", "claude-code", "--input", t, "--path", root, "--json"]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.equal(imp.json!.inserted, 3);
  const db = openProjectDb(pmHome);
  try {
    const rows = db.prepare("SELECT lineage, content FROM events").all() as { lineage: string; content: string }[];
    assert.ok(!rows.some((r) => r.content.includes("HIDDEN")));
    const lineages = new Set(rows.map((r) => r.lineage));
    assert.equal(lineages.size, 2, "fork isolated from main lineage");
    const fts = db.prepare("SELECT COUNT(*) AS c FROM event_fts WHERE event_fts MATCH 'HIDDEN'").get() as { c: number };
    assert.equal(fts.c, 0, "hidden text never enters FTS");
  } finally {
    db.close();
  }
});

test("codex: rollout parsing retains messages/tools, discards reasoning", () => {
  const lines = [
    { timestamp: "2026-09-12T10:00:00Z", type: "session_meta", payload: { id: "codex-s1" } },
    { timestamp: "2026-09-12T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "cap retries" }] } },
    { timestamp: "2026-09-12T10:00:02Z", type: "response_item", payload: { type: "reasoning", summary: [{ text: "INTERNAL-REASONING" }] } },
    { timestamp: "2026-09-12T10:00:03Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"cmd\":\"ls\"}", id: "fc1" } },
    { timestamp: "2026-09-12T10:00:04Z", type: "response_item", payload: { type: "function_call_output", output: "file1", id: "fo1" } },
    { timestamp: "2026-09-12T10:00:05Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
  ];
  const parsed = codexAdapter.parse(lines.map((l) => JSON.stringify(l)).join("\n"), "test");
  assert.equal(parsed.spec.sourceSession, "codex-s1");
  assert.equal(parsed.events.length, 4);
  const all = parsed.events.map((e) => e.content).join("\n");
  assert.ok(!all.includes("INTERNAL-REASONING"));
  assert.ok(parsed.events.some((e) => e.role === "tool_input" && e.content.includes("[tool:shell]")));
});

test("codex: missing session_meta is rejected", () => {
  const lines = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x" }] } },
  ];
  assert.throws(() => codexAdapter.parse(lines.map((l) => JSON.stringify(l)).join("\n"), "test"));
});

test("cursor: thought events discarded; generation ids map to lineages", () => {
  const doc = {
    conversationId: "conv-1",
    messages: [
      { id: "m1", generationId: "g1", role: "user", content: "make retries 3" },
      { id: "m2", generationId: "g1", role: "assistant", type: "thought", content: "HIDDEN-THOUGHT" },
      { id: "m3", generationId: "g1", role: "assistant", content: "ok" },
      { id: "m4", generationId: "g2", role: "user", content: "second generation" },
    ],
  };
  const parsed = cursorAdapter.parse(JSON.stringify(doc), "test");
  assert.equal(parsed.spec.sourceSession, "conv-1");
  assert.equal(parsed.events.length, 3);
  assert.ok(!parsed.events.some((e) => e.content.includes("HIDDEN-THOUGHT")));
  const lineages = new Set(parsed.events.map((e) => e.lineage));
  assert.equal(lineages.size, 2);
  assert.ok(parsed.warnings.some((w) => w.includes("thought")));
});

test("cursor end-to-end via CLI", () => {
  const { pmHome } = makeEnv();
  const dir = makeGitProject("cursorimport");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  const root = init.json!.root as string;
  const doc = {
    conversationId: "conv-cli",
    messages: [
      { id: "m1", generationId: "g1", role: "user", content: "hello cursor" },
      { id: "m2", generationId: "g1", role: "assistant", content: "hi" },
    ],
  };
  const p = join(root, "cursor.json");
  writeFileSync(p, JSON.stringify(doc));
  const imp = run(pmHome, ["capture", "import", "--adapter", "cursor", "--input", p, "--path", root, "--json"]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.equal(imp.json!.inserted, 2);
});

test("generic: malformed lines produce gap warnings, not crashes", () => {
  const { pmHome } = makeEnv();
  const dir = makeGitProject("malformed");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  const root = init.json!.root as string;
  const p = join(root, "bad.jsonl");
  writeFileSync(
    p,
    JSON.stringify({ type: "header", adapter: "generic", session: "s-bad" }) +
      "\n{not json}\n" +
      JSON.stringify({ type: "event", event_id: "e1", role: "user", content: "ok line" }) +
      "\n" +
      JSON.stringify({ type: "event", event_id: "e2", role: "thinking", content: "DISCARDED-ROLE" }) +
      "\n",
  );
  const imp = run(pmHome, ["capture", "import", "--adapter", "generic", "--input", p, "--path", root, "--json"]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.equal(imp.json!.inserted, 1);
  assert.ok((imp.json!.warnings as string[]).some((w) => w.includes("malformed")));
  const coverage = imp.json!.coverage as { status: string }[];
  assert.equal(coverage[0]!.status, "unverified", "gap: continuity is not claimed");
});
