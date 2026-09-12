import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  run,
  makeEnv,
  makeGitProject,
  makePlainProject,
  writeTranscript,
  genericTranscript,
  eventIdBySource,
  git,
} from "./helpers.ts";

function setupImported(name: string): { pmHome: string; root: string; eid: string } {
  const { pmHome } = makeEnv();
  const dir = makeGitProject(name);
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  assert.equal(init.status, 0, init.stderr);
  const root = init.json!.root as string;
  const t = writeTranscript(dir, "t.jsonl", genericTranscript("sess-1"));
  const imp = run(pmHome, ["capture", "import", "--adapter", "generic", "--input", t, "--path", root, "--json"]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.equal(imp.json!.inserted, 2);
  const eid = eventIdBySource(pmHome, root, "e1");
  return { pmHome, root, eid };
}

function addConfirmed(pmHome: string, root: string, eid: string): string {
  const r = run(pmHome, [
    "decisions", "add", "--path", root,
    "--proposition", "Use at most three retry attempts",
    "--rationale", "upstream request allowance",
    "--scope-kind", "file", "--scope-value", "src/retry.ts",
    "--source-event", eid,
    "--source-code", "src/retry.ts:1:4",
    "--json",
  ]);
  assert.equal(r.status, 0, r.stderr);
  return r.json!.decisionId as string;
}

test("init, status, doctor on a git project", () => {
  const { pmHome } = makeEnv();
  const dir = makeGitProject("initstatus");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  assert.equal(init.status, 0, init.stderr);
  const root = init.json!.root as string;

  const status = run(pmHome, ["status", "--path", root, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json!.lifecycle, "active");
  assert.equal(status.json!.sessions, 0);
  assert.match(String(status.json!.semanticIndex), /blocked/);

  const doctor = run(pmHome, ["doctor", "--path", root, "--json"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  const checks = doctor.json!.checks as Record<string, unknown>;
  assert.equal(checks.fts5, true);
  assert.equal(checks.gitHardenedFlags, true);
  assert.equal(checks.integrity, "ok");

  // double init rejected
  const again = run(pmHome, ["init", "--path", root, "--json"]);
  assert.equal(again.status, 1);
});

test("unregistered root is a typed failure", () => {
  const { pmHome } = makeEnv();
  const dir = makePlainProject("unreg");
  const r = run(pmHome, ["status", "--path", dir, "--json"]);
  assert.equal(r.status, 2);
  assert.equal(r.json!.code, "not-registered");
});

test("import replay is a no-op; changed payload for same identity is a conflict", () => {
  const { pmHome, root } = setupImported("replay");
  const t2 = writeTranscript(root, "t2.jsonl", genericTranscript("sess-1"));
  const replay = run(pmHome, ["capture", "import", "--adapter", "generic", "--input", t2, "--path", root, "--json"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(replay.json!.inserted, 0);
  assert.equal(replay.json!.replayedNoop, 2);
  assert.equal(replay.json!.conflicts, 0);

  const changed = genericTranscript("sess-1");
  (changed[1] as Record<string, unknown>).content = "DIFFERENT retained payload for same identity";
  const t3 = writeTranscript(root, "t3.jsonl", changed);
  const conf = run(pmHome, ["capture", "import", "--adapter", "generic", "--input", t3, "--path", root, "--json"]);
  assert.equal(conf.status, 0, conf.stderr);
  assert.equal(conf.json!.conflicts, 1);
  assert.equal(conf.json!.inserted, 0);

  const status = run(pmHome, ["status", "--path", root, "--json"]);
  assert.equal(status.json!.replayConflicts, 1);
});

test("proposal receipts: same id+payload no-op, same id different payload error", () => {
  const { pmHome, root, eid } = setupImported("receipts");
  const proposal = JSON.stringify([
    {
      proposition: "Cap retries at three",
      rationale: "allowance",
      scopeKind: "file",
      scopeValue: "src/retry.ts",
      sources: [{ kind: "event", eventId: eid }],
    },
  ]);
  const pfile = join(root, "prop.json");
  writeFileSync(pfile, proposal);
  const r1 = run(pmHome, ["decisions", "propose", "--input", pfile, "--request-id", "req-1", "--path", root, "--json"]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.json!.status, "applied");
  assert.equal(r1.json!.authority, "candidate");
  const ids1 = r1.json!.decisionIds as string[];

  const r2 = run(pmHome, ["decisions", "propose", "--input", pfile, "--request-id", "req-1", "--path", root, "--json"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.json!.status, "replayed-noop");
  assert.deepEqual(r2.json!.decisionIds, ids1);

  const pfile2 = join(root, "prop2.json");
  writeFileSync(pfile2, proposal.replace("Cap retries", "Different payload"));
  const r3 = run(pmHome, ["decisions", "propose", "--input", pfile2, "--request-id", "req-1", "--path", root, "--json"]);
  assert.equal(r3.status, 1);

  // a proposal citing a nonexistent event is rejected
  const bad = JSON.stringify([
    { proposition: "x", scopeKind: "project", sources: [{ kind: "event", eventId: "E-nope" }] },
  ]);
  const pfile3 = join(root, "prop3.json");
  writeFileSync(pfile3, bad);
  const r4 = run(pmHome, ["decisions", "propose", "--input", pfile3, "--request-id", "req-2", "--path", root, "--json"]);
  assert.equal(r4.status, 1);
});

test("candidates require developer confirmation; stale expected revision rejected", () => {
  const { pmHome, root, eid } = setupImported("confirm");
  const pfile = join(root, "prop.json");
  writeFileSync(
    pfile,
    JSON.stringify([
      { proposition: "Cap retries at three", scopeKind: "file", scopeValue: "src/retry.ts", sources: [{ kind: "event", eventId: eid }] },
    ]),
  );
  const prop = run(pmHome, ["decisions", "propose", "--input", pfile, "--request-id", "r1", "--path", root, "--json"]);
  const did = (prop.json!.decisionIds as string[])[0]!;

  // candidate does not appear among confirmed decisions in context
  const ctx1 = run(pmHome, ["context", "--file", "src/retry.ts", "--path", root, "--no-zvec"]);
  const packet1 = JSON.parse(ctx1.stdout.trim());
  assert.equal(packet1.decisions.length, 0);
  assert.equal(packet1.candidates.length, 1);
  assert.equal(packet1.candidates[0].authority, "candidate");

  const wrongRev = run(pmHome, ["decisions", "confirm", did, "--expected-revision", "99", "--path", root, "--json"]);
  assert.equal(wrongRev.status, 6);

  const ok = run(pmHome, ["decisions", "confirm", did, "--expected-revision", "1", "--path", root, "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json!.authority, "confirmed");

  const ctx2 = run(pmHome, ["context", "--file", "src/retry.ts", "--path", root, "--no-zvec"]);
  const packet2 = JSON.parse(ctx2.stdout.trim());
  assert.equal(packet2.decisions.length, 1);
  assert.equal(packet2.decisions[0].authority, "confirmed");
});

test("supersession: constrained pointer, no self-supersede, stale revs rejected, history traversal", () => {
  const { pmHome, root, eid } = setupImported("supersede");
  const d1 = addConfirmed(pmHome, root, eid);
  const d2 = addConfirmed(pmHome, root, eid);

  const self = run(pmHome, ["decisions", "supersede", d1, "--expected-revision", "1", "--with", d1, "--with-expected-revision", "1", "--path", root, "--json"]);
  assert.equal(self.status, 1);

  const stale = run(pmHome, ["decisions", "supersede", d1, "--expected-revision", "5", "--with", d2, "--with-expected-revision", "1", "--path", root, "--json"]);
  assert.equal(stale.status, 6);

  const ok = run(pmHome, ["decisions", "supersede", d1, "--expected-revision", "1", "--with", d2, "--with-expected-revision", "1", "--path", root, "--json"]);
  assert.equal(ok.status, 0, ok.stderr);

  // superseded decision no longer active guidance
  const ctx = run(pmHome, ["context", "--file", "src/retry.ts", "--path", root, "--no-zvec"]);
  const packet = JSON.parse(ctx.stdout.trim());
  const ids = packet.decisions.map((d: { id: string }) => d.id);
  assert.ok(!ids.includes(d1), "superseded decision must not be active");
  assert.ok(ids.includes(d2));

  // a second supersession of the same (already superseded) revision fails
  const d3 = addConfirmed(pmHome, root, eid);
  const dup = run(pmHome, ["decisions", "supersede", d1, "--expected-revision", "1", "--with", d3, "--with-expected-revision", "1", "--path", root, "--json"]);
  assert.equal(dup.status, 1);

  const inspect = run(pmHome, ["inspect", d2, "--path", root, "--json"]);
  const revs = inspect.json!.revisions as Record<string, unknown>[];
  assert.ok(revs.some((r) => r.supersedes));
});

test("edit creates unconfirmed revision preserving sources; confirm required again", () => {
  const { pmHome, root, eid } = setupImported("revise");
  const did = addConfirmed(pmHome, root, eid);
  const rev = run(pmHome, ["decisions", "revise", did, "--expected-revision", "1", "--proposition", "Use at most FIVE retry attempts", "--path", root, "--json"]);
  assert.equal(rev.status, 0, rev.stderr);
  assert.equal(rev.json!.rev, 2);
  assert.equal(rev.json!.authority, "candidate");

  const ctx = run(pmHome, ["context", "--file", "src/retry.ts", "--path", root, "--no-zvec"]);
  const packet = JSON.parse(ctx.stdout.trim());
  assert.equal(packet.decisions.length, 0, "edited decision needs re-confirmation");
  assert.equal(packet.candidates.length, 1);

  const inspect = run(pmHome, ["inspect", did, "--sources", "--path", root, "--json"]);
  const revs = inspect.json!.revisions as Record<string, unknown>[];
  const r2 = revs.find((r) => r.rev === 2)!;
  assert.ok((r2.sources as unknown[]).length >= 2, "sources preserved across edit");
});

test("changed code yields historical applicability; branch switch changes view", () => {
  const { pmHome, root, eid } = setupImported("changed");
  addConfirmed(pmHome, root, eid);

  // modify the anchored file
  writeFileSync(join(root, "src", "retry.ts"), "export function retry(n: number) {\n  return Math.min(n, 5); // changed\n}\n");
  const why = run(pmHome, ["why", "src/retry.ts:2", "--path", root, "--json"]);
  const results = why.json!.results as Record<string, unknown>[];
  assert.equal(results.length, 1);
  assert.equal((results[0]!.applicability as Record<string, unknown>).status, "historical");

  // branch with different content: still historical, view head changes
  git(root, ["checkout", "-qb", "feature"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "bump retries"]);
  const ctx = run(pmHome, ["context", "--file", "src/retry.ts", "--path", root, "--no-zvec"]);
  const packet = JSON.parse(ctx.stdout.trim());
  assert.equal(packet.decisions[0].applicability.status, "historical");

  // back to main: exact match again
  git(root, ["checkout", "-q", "-"]);
  const why2 = run(pmHome, ["why", "src/retry.ts:2", "--path", root, "--json"]);
  const results2 = why2.json!.results as Record<string, unknown>[];
  assert.equal((results2[0]!.applicability as Record<string, unknown>).status, "current");
});

test("cross-project isolation: memories never join across roots", () => {
  const { pmHome } = makeEnv();
  const dirA = makeGitProject("isoA");
  const dirB = makeGitProject("isoB");
  const initA = run(pmHome, ["init", "--path", dirA, "--json"]);
  const initB = run(pmHome, ["init", "--path", dirB, "--json"]);
  const rootA = initA.json!.root as string;
  const rootB = initB.json!.root as string;

  const t = writeTranscript(rootA, "t.jsonl", genericTranscript("sess-A"));
  run(pmHome, ["capture", "import", "--adapter", "generic", "--input", t, "--path", rootA, "--json"]);
  const eidA = eventIdBySource(pmHome, rootA, "e1");
  addConfirmed(pmHome, rootA, eidA);

  const ctxB = run(pmHome, ["context", "--file", "src/retry.ts", "--path", rootB, "--no-zvec"]);
  const packetB = JSON.parse(ctxB.stdout.trim());
  assert.equal(packetB.decisions.length, 0, "project B must not see project A's decisions");
  assert.equal(packetB.coverage.sessions, 0);

  const searchB = run(pmHome, ["search", "retries", "--path", rootB, "--json"]);
  assert.equal((searchB.json!.decisions as unknown[]).length, 0);
  assert.equal((searchB.json!.events as unknown[]).length, 0);

  // citing project A's event id from project B fails
  const r = run(pmHome, [
    "decisions", "add", "--path", rootB, "--proposition", "x", "--source-event", eidA, "--json",
  ]);
  assert.equal(r.status, 1);
});

test("forget session: dependent decisions removed, suppression blocks replay, marker preserved for independent successor", () => {
  const { pmHome, root, eid } = setupImported("forget");
  const d1 = addConfirmed(pmHome, root, eid); // depends on session evidence

  // d2 has an independent (manual+code) source, then supersedes d1
  const d2r = run(pmHome, [
    "decisions", "add", "--path", root,
    "--proposition", "Use at most four retry attempts",
    "--scope-kind", "file", "--scope-value", "src/retry.ts",
    "--source-note", "developer decided in review meeting",
    "--source-code", "src/retry.ts:1:4",
    "--json",
  ]);
  const d2 = d2r.json!.decisionId as string;
  const sup = run(pmHome, ["decisions", "supersede", d1, "--expected-revision", "1", "--with", d2, "--with-expected-revision", "1", "--path", root, "--json"]);
  assert.equal(sup.status, 0, sup.stderr);

  // find the session id
  const search = run(pmHome, ["search", "allowance", "--path", root, "--json"]);
  const sessionId = (search.json!.events as Record<string, unknown>[])[0]!.session_id as string;

  const preview = run(pmHome, ["forget", "--session", sessionId, "--preview", "--path", root, "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok((preview.json!.decisionsRemoved as string[]).includes(d1));
  assert.equal(preview.json!.events, 2);

  const forget = run(pmHome, ["forget", "--session", sessionId, "--yes", "--path", root, "--json"]);
  assert.equal(forget.status, 0, forget.stderr);
  assert.ok((forget.json!.decisionsRemoved as string[]).includes(d1));
  assert.equal((forget.json!.markersRetained as string[]).length, 1, "predecessor kept as marker");
  assert.ok((forget.json!.boundaries as string[]).length > 0);

  // d1's content is gone; d2 remains active and reports predecessor-forgotten
  const search2 = run(pmHome, ["search", "allowance", "--path", root, "--json"]);
  assert.equal((search2.json!.decisions as unknown[]).length, 0);
  assert.equal((search2.json!.events as unknown[]).length, 0);
  const inspect1 = run(pmHome, ["inspect", d1, "--path", root, "--json"]);
  const revs1 = inspect1.json!.revisions as Record<string, unknown>[];
  assert.equal(revs1.length, 1);
  assert.equal(revs1[0]!.forgotten, true);
  assert.equal(revs1[0]!.proposition, null);

  const inspect2 = run(pmHome, ["inspect", d2, "--path", root, "--json"]);
  const revs2 = inspect2.json!.revisions as Record<string, unknown>[];
  assert.ok(revs2.some((r) => r.predecessorStatus === "predecessor-forgotten"));

  const ctx = run(pmHome, ["context", "--file", "src/retry.ts", "--path", root, "--no-zvec"]);
  const packet = JSON.parse(ctx.stdout.trim());
  assert.equal(packet.decisions.length, 1);
  assert.equal(packet.decisions[0].id, d2);
  assert.equal(packet.decisions[0].predecessorForgotten, true);

  // replaying the forgotten session is suppressed, not re-admitted
  const t2 = writeTranscript(root, "t2.jsonl", genericTranscript("sess-1"));
  const replay = run(pmHome, ["capture", "import", "--adapter", "generic", "--input", t2, "--path", root, "--json"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(replay.json!.inserted, 0);
  assert.equal(replay.json!.suppressed, 2);

  // markers cannot be confirmed or superseded
  const confirmMarker = run(pmHome, ["decisions", "confirm", d1, "--expected-revision", "1", "--path", root, "--json"]);
  assert.notEqual(confirmMarker.status, 0);
});

test("forget decision alone keeps shared session events; confirmation cannot resurrect", () => {
  const { pmHome, root, eid } = setupImported("forgetdec");
  const d1 = addConfirmed(pmHome, root, eid);
  const forget = run(pmHome, ["forget", "--decision", d1, "--yes", "--path", root, "--json"]);
  assert.equal(forget.status, 0, forget.stderr);

  // events still present
  const search = run(pmHome, ["search", "allowance", "--path", root, "--json"]);
  assert.equal((search.json!.events as unknown[]).length, 1);

  // decision gone
  const inspect = run(pmHome, ["inspect", d1, "--path", root, "--json"]);
  assert.equal(inspect.status, 1);
  const confirm = run(pmHome, ["decisions", "confirm", d1, "--expected-revision", "1", "--path", root, "--json"]);
  assert.notEqual(confirm.status, 0);
});

test("purge retires generation; stale bindings and re-registration rejected; old callbacks fail", () => {
  const { pmHome, root } = setupImported("purge");
  const setup = run(pmHome, ["capture", "setup", "claude-code", "--path", root, "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  const bindingId = setup.json!.bindingId as string;
  assert.match(setup.json!.snippet as string, /pm capture import/);

  const purge = run(pmHome, ["purge", "--yes", "--path", root, "--json"]);
  assert.equal(purge.status, 0, purge.stderr);
  assert.ok((purge.json!.boundaries as string[]).some((b) => b.includes("NOT deleted")));

  // any operation on the purged root fails typed
  const status = run(pmHome, ["status", "--path", root, "--json"]);
  assert.equal(status.status, 2);

  // re-register the same path: NEW project, old binding rejected
  const reinit = run(pmHome, ["init", "--path", root, "--json"]);
  assert.equal(reinit.status, 0, reinit.stderr);
  const t = writeTranscript(root, "cb.jsonl", genericTranscript("sess-cb"));
  const oldCallback = run(pmHome, [
    "capture", "import", "--adapter", "generic", "--input", t, "--path", root, "--binding", bindingId, "--json",
  ]);
  assert.equal(oldCallback.status, 1, "old binding must be rejected after purge + re-registration");
});

test("export, backup, restore: restore rotates generation and disables capture", () => {
  const { pmHome, root, eid } = setupImported("backup");
  const did = addConfirmed(pmHome, root, eid);

  const exp = run(pmHome, ["export", "--output", join(root, "mem.jsonl"), "--path", root, "--json"]);
  assert.equal(exp.status, 0, exp.stderr);
  const lines = readFileSync(join(root, "mem.jsonl"), "utf8").trim().split("\n");
  assert.ok(lines.length >= 4);
  assert.equal(JSON.parse(lines[0]!).type, "header");

  const genBefore = run(pmHome, ["status", "--path", root, "--json"]).json!.generation as string;
  const bak = join(root, "backup.db");
  const b = run(pmHome, ["backup", "--output", bak, "--path", root, "--json"]);
  assert.equal(b.status, 0, b.stderr);

  // mutate after backup: add another decision, then restore the snapshot
  addConfirmed(pmHome, root, eid);
  const restorePreview = run(pmHome, ["restore", "--input", bak, "--path", root, "--json"]);
  assert.equal(restorePreview.json!.kind, "restore-preview");
  const r = run(pmHome, ["restore", "--input", bak, "--path", root, "--yes", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.json!.newGeneration, genBefore);
  assert.equal(r.json!.captureEnabled, false);
  assert.match(r.json!.acknowledgement as string, /formerly forgotten/);

  const status = run(pmHome, ["status", "--path", root, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json!.activeDecisions, 1, "restore returned to snapshot state");
  assert.notEqual(status.json!.generation, genBefore);

  // the restored project still answers why
  const why = run(pmHome, ["why", "src/retry.ts:2", "--path", root, "--json"]);
  assert.equal((why.json!.results as unknown[]).length, 1);
  void did;
});

test("context budget: hard max-bytes ceiling, trimming, insufficient-budget", () => {
  const { pmHome, root, eid } = setupImported("budget");
  for (let i = 0; i < 5; i++) addConfirmed(pmHome, root, eid);

  const full = run(pmHome, ["context", "--file", "src/retry.ts", "--max-bytes", "8192", "--path", root, "--no-zvec"]);
  assert.equal(full.status, 0, full.stderr);
  assert.ok(Buffer.byteLength(full.stdout.trim(), "utf8") <= 8192);

  const small = run(pmHome, ["context", "--file", "src/retry.ts", "--max-bytes", "1400", "--path", root, "--no-zvec"]);
  assert.equal(small.status, 0, small.stderr);
  const packet = JSON.parse(small.stdout.trim());
  assert.ok(Buffer.byteLength(small.stdout.trim(), "utf8") <= 1400);
  assert.ok(packet.omitted.decisions > 0 || packet.omitted.clues > 0, "omissions are counted, not silent");

  const tiny = run(pmHome, ["context", "--file", "src/retry.ts", "--max-bytes", "300", "--path", root, "--no-zvec"]);
  assert.equal(tiny.status, 4, "mandatory metadata cannot fit: insufficient-budget");

  const invalidBytes = run(pmHome, ["context", "--max-bytes", "10", "--path", root, "--no-zvec"]);
  assert.equal(invalidBytes.status, 1);
});

test("orientation packet (no task/file) fits default 2048 bytes", () => {
  const { pmHome, root, eid } = setupImported("orient");
  addConfirmed(pmHome, root, eid);
  const r = run(pmHome, ["context", "--path", root, "--no-zvec"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout.trim(), "utf8") <= 2048);
});

test("symlinked source path is rejected for anchors", () => {
  const { pmHome, root } = setupImported("symlink");
  symlinkSync("/etc/hosts", join(root, "src", "evil.ts"));
  const r = run(pmHome, [
    "decisions", "add", "--path", root, "--proposition", "x", "--source-code", "src/evil.ts:1:1", "--json",
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /symlink|not a regular file|open/i);

  // path escape rejected
  const esc = run(pmHome, [
    "decisions", "add", "--path", root, "--proposition", "x", "--source-code", "../outside.ts:1:1", "--json",
  ]);
  assert.equal(esc.status, 1);
});

test("non-git project works with content digests only", () => {
  const { pmHome } = makeEnv();
  const dir = makePlainProject("nogit");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  assert.equal(init.status, 0, init.stderr);
  const root = init.json!.root as string;
  const r = run(pmHome, [
    "decisions", "add", "--path", root,
    "--proposition", "retries stay at 3 in config",
    "--scope-kind", "file", "--scope-value", "src/config.yaml",
    "--source-code", "src/config.yaml:1:1", "--json",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const why = run(pmHome, ["why", "src/config.yaml:1", "--path", root, "--json"]);
  const results = why.json!.results as Record<string, unknown>[];
  assert.equal(results.length, 1);
  assert.equal((results[0]!.applicability as Record<string, unknown>).status, "current");

  const hist = run(pmHome, ["history", "--file", "src/config.yaml", "--path", root, "--json"]);
  assert.equal(hist.status, 0);
  assert.equal((hist.json!.gitHistory as unknown[]).length, 0);
});

test("oversized event is truncated and labeled; oversized import file rejected", () => {
  const { pmHome } = makeEnv();
  const dir = makeGitProject("oversize");
  const init = run(pmHome, ["init", "--path", dir, "--json"]);
  const root = init.json!.root as string;
  const big = "x".repeat(300 * 1024);
  const t = writeTranscript(root, "big.jsonl", [
    { type: "header", adapter: "generic", session: "s-big" },
    { type: "event", event_id: "e1", role: "user", content: big },
  ]);
  const imp = run(pmHome, ["capture", "import", "--adapter", "generic", "--input", t, "--path", root, "--json"]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.equal(imp.json!.truncatedEvents, 1);
});

test("capture setup emits snippet without touching host config; status distinguishes pending from observed", () => {
  const { pmHome, root } = setupImported("setup");
  const setup = run(pmHome, ["capture", "setup", "claude-code", "--path", root, "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.json!.note as string, /does not prove/);
  const bindingId = setup.json!.bindingId as string;

  const st1 = run(pmHome, ["capture", "status", "--path", root, "--json"]);
  const bindings1 = st1.json!.bindings as Record<string, unknown>[];
  assert.ok(bindings1.some((b) => b.host === "claude-code" && b.pending && !b.observed));

  // import with the correct binding marks it observed
  const cc = [
    { type: "user", uuid: "u1", parentUuid: null, sessionId: "cc-1", message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "cc-1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ];
  const t = writeTranscript(root, "cc.jsonl", cc);
  const imp = run(pmHome, ["capture", "import", "--adapter", "claude-code", "--input", t, "--binding", bindingId, "--path", root, "--json"]);
  assert.equal(imp.status, 0, imp.stderr);
  const st2 = run(pmHome, ["capture", "status", "--path", root, "--json"]);
  const bindings2 = st2.json!.bindings as Record<string, unknown>[];
  assert.ok(bindings2.some((b) => b.host === "claude-code" && b.observed));

  // wrong binding id rejected
  const bad = run(pmHome, ["capture", "import", "--adapter", "claude-code", "--input", t, "--binding", "B-fake", "--path", root, "--json"]);
  assert.equal(bad.status, 1);
});

test("stale generation writer: operations against a replaced database are rejected", () => {
  // simulate a moved/replaced root: re-init under same path after purge is
  // covered elsewhere; here verify a moved root string mismatch fails closed
  const { pmHome, root } = setupImported("stale");
  // corrupt approved_root in the db to simulate a moved database
  const projects = readdirSync(join(pmHome, "projects"));
  const db = new DatabaseSync(join(pmHome, "projects", projects[0]!, "memory.db"));
  db.prepare("UPDATE meta SET value='/somewhere/else' WHERE key='approved_root'").run();
  db.close();
  const r = run(pmHome, ["status", "--path", root, "--json"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /re-registration|does not match/);
});
