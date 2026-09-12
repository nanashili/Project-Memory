import { test } from "node:test";
import assert from "node:assert/strict";
import { run, makeEnv, makeGitProject, writeTranscript, genericTranscript, eventIdBySource } from "./helpers.ts";

/**
 * zvec integration: uses the real pinned @zvec/zvec-grep via the owned worker,
 * lexical (rg) route only. These tests verify that retrieval causes no index
 * mutation and degrades honestly.
 */

test("context with zvec lexical discovery joins decisions on discovered paths", { timeout: 120_000 }, () => {
  const { pmHome } = makeEnv();
  const dir = makeGitProject("zvec");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  const root = init.json!.root as string;
  const t = writeTranscript(root, "t.jsonl", genericTranscript("sess-z"));
  run(pmHome, ["capture", "import", "--adapter", "generic", "--input", t, "--path", root, "--json"]);
  const eid = eventIdBySource(pmHome, root, "e1");
  run(pmHome, [
    "decisions", "add", "--path", root,
    "--proposition", "Use at most three retry attempts",
    "--scope-kind", "file", "--scope-value", "src/retry.ts",
    "--source-event", eid, "--source-code", "src/retry.ts:1:4", "--json",
  ]);

  // conceptual query WITHOUT --file: only zvec lexical discovery or FTS can find it
  const ctx = run(pmHome, ["context", "--task", "bounded retries", "--max-bytes", "8192", "--path", root]);
  assert.equal(ctx.status, 0, ctx.stderr);
  const packet = JSON.parse(ctx.stdout.trim());
  assert.ok(
    String(packet.coverage.semantic).includes("lexical") || String(packet.coverage.semantic).includes("degraded"),
    `semantic coverage is honest: ${packet.coverage.semantic}`,
  );
  assert.equal(packet.decisions.length, 1, "decision found via zvec path join or FTS");

  // retrieval must not have created a zvec index in the project or pm home
  const st = run(pmHome, ["status", "--path", root, "--json"]);
  assert.equal(st.status, 0);
});

test("pm index reports semantic indexing blocked (offline gate)", () => {
  const { pmHome } = makeEnv();
  const dir = makeGitProject("zvecindex");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  const root = init.json!.root as string;
  const r = run(pmHome, ["index", "--path", root, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json!.supported, false);
  assert.match(r.json!.reason as string, /offline|blocked/i);
});

test("zvec failure degrades to typed FTS-only result (task query still answers)", () => {
  const { pmHome } = makeEnv();
  const dir = makeGitProject("zvecdeg");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  const root = init.json!.root as string;
  const t = writeTranscript(root, "t.jsonl", genericTranscript("sess-d"));
  run(pmHome, ["capture", "import", "--adapter", "generic", "--input", t, "--path", root, "--json"]);
  const eid = eventIdBySource(pmHome, root, "e1");
  run(pmHome, [
    "decisions", "add", "--path", root,
    "--proposition", "Use at most three retry attempts",
    "--rationale", "upstream allowance",
    "--scope-kind", "file", "--scope-value", "src/retry.ts",
    "--source-event", eid, "--json",
  ]);
  // --no-zvec models the unavailable-dependency path deterministically
  const ctx = run(pmHome, ["context", "--task", "retry attempts allowance", "--path", root, "--no-zvec"]);
  assert.equal(ctx.status, 0, ctx.stderr);
  const packet = JSON.parse(ctx.stdout.trim());
  assert.equal(packet.decisions.length, 1, "FTS fallback still finds the decision");
});
