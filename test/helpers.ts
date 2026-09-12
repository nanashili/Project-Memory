import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = join(fileURLToPath(import.meta.url), "..", "..", "src", "cli.ts");

export type CliResult = {
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | undefined;
};

export function makeEnv(): { pmHome: string } {
  return { pmHome: mkdtempSync(join(tmpdir(), "pm-home-")) };
}

export function run(pmHome: string, args: string[], stdin?: string): CliResult {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, PM_HOME: pmHome },
    input: stdin,
    timeout: 60_000,
  });
  const stdout = res.stdout ?? "";
  let json: Record<string, unknown> | undefined;
  const lastLine = stdout.trim().split("\n").pop();
  if (lastLine?.startsWith("{")) {
    try {
      json = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
  }
  return { status: res.status ?? -1, stdout, stderr: res.stderr ?? "", json };
}

export function makeGitProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pm-proj-${name}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "retry.ts"),
    "export function retry(n: number) {\n  // bounded retries\n  return Math.min(n, 3);\n}\n",
  );
  git(dir, ["init", "-q", "."]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "add retry"]);
  return dir;
}

export function makePlainProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pm-plain-${name}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "config.yaml"), "retries: 3\ntimeout: 30\n");
  return dir;
}

export function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

export function writeTranscript(dir: string, name: string, lines: object[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

export function genericTranscript(session: string): object[] {
  return [
    { type: "header", adapter: "generic", session, lineage: "main" },
    { type: "event", event_id: "e1", role: "user", content: "Please cap retries at three attempts. Upstream has a request allowance." },
    { type: "event", event_id: "e2", role: "assistant", content: "Done: retry() caps attempts at 3 in src/retry.ts." },
  ];
}

export function eventIdBySource(pmHome: string, root: string, sourceEvent: string): string {
  // tests locate the db file directly to fetch generated event ids
  const projects = readdirSync(join(pmHome, "projects"));
  for (const pid of projects) {
    const db = new DatabaseSync(join(pmHome, "projects", pid, "memory.db"), { readOnly: true });
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key='approved_root'").get() as
        | { value: string }
        | undefined;
      if (meta?.value !== root) continue;
      const row = db.prepare("SELECT id FROM events WHERE source_event = ?").get(sourceEvent) as
        | { id: string }
        | undefined;
      if (row) return row.id;
    } finally {
      db.close();
    }
  }
  throw new Error(`event ${sourceEvent} not found`);
}
