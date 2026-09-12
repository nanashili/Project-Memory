import type { Project } from "./project.ts";
import { getMeta, setMeta } from "./db.ts";
import { invalid, newId, nowIso } from "./util.ts";

const SUPPORTED_HOSTS = ["claude-code", "codex", "cursor"] as const;
export type Host = (typeof SUPPORTED_HOSTS)[number];

export type SetupResult = {
  host: Host;
  bindingId: string;
  snippet: string;
  retainedClasses: string[];
  note: string;
};

/**
 * `pm capture setup <host>`: emits a version-specific configuration snippet and
 * a pending binding ID for the developer to add to the host themselves. It
 * NEVER rewrites shared host configuration and never claims installation.
 */
export function captureSetup(project: Project, host: string): SetupResult {
  if (!SUPPORTED_HOSTS.includes(host as Host)) {
    throw invalid(`unsupported host '${host}'; supported: ${SUPPORTED_HOSTS.join(", ")}`);
  }
  const bindingId = newId("B");
  setMeta(
    project.db,
    `pending_binding_${host}`,
    JSON.stringify({ bindingId, generation: project.identity.generation, createdAt: nowIso() }),
  );
  const root = project.identity.root;
  const retainedClasses = [
    "visible user text",
    "visible assistant text",
    "approved tool inputs (bounded)",
    "bounded tool results",
    "NOT retained: thinking/reasoning, provider-internal events, credentials, environment dumps, binaries",
  ];
  let snippet: string;
  if (host === "claude-code") {
    snippet = JSON.stringify(
      {
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: `pm capture import --adapter claude-code --input "$CLAUDE_TRANSCRIPT_PATH" --path ${root} --binding ${bindingId}`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
  } else if (host === "codex") {
    snippet = `# add to your Codex hooks configuration (pin your installed release first):
# on session end, run:
pm capture import --adapter codex --input <rollout-path> --path ${root} --binding ${bindingId}`;
  } else {
    snippet = `# add to your Cursor hooks configuration (pin your installed release first):
# on stop, when a transcript path is supplied, run:
pm capture import --adapter cursor --input <transcript-path> --path ${root} --binding ${bindingId}`;
  }
  return {
    host: host as Host,
    bindingId,
    snippet,
    retainedClasses,
    note: "setup generated a pending binding only; it does not prove an installed adapter or complete capture. Add the snippet to the host yourself.",
  };
}

export type BindingStatus = {
  host: string;
  pending?: { bindingId: string; createdAt: string };
  observed?: { bindingId: string; observedAt: string };
};

export function captureStatus(project: Project): BindingStatus[] {
  const out: BindingStatus[] = [];
  for (const host of SUPPORTED_HOSTS) {
    const s: BindingStatus = { host };
    const pending = getMeta(project.db, `pending_binding_${host}`);
    if (pending) {
      const p = JSON.parse(pending) as { bindingId: string; createdAt: string; generation: string };
      if (p.generation === project.identity.generation) {
        s.pending = { bindingId: p.bindingId, createdAt: p.createdAt };
      }
    }
    const observed = getMeta(project.db, `observed_binding_${host}`);
    if (observed) {
      const o = JSON.parse(observed) as { bindingId: string; observedAt: string; generation: string };
      if (o.generation === project.identity.generation) {
        s.observed = { bindingId: o.bindingId, observedAt: o.observedAt };
      }
    }
    if (s.pending || s.observed) out.push(s);
  }
  return out;
}

/**
 * Validate a callback-supplied binding against the registered pending binding.
 * A callback never creates or reactivates a project; purge/restore invalidates
 * bindings because the generation is embedded and rotated.
 */
export function validateBinding(project: Project, host: string, bindingId: string): void {
  const pending = getMeta(project.db, `pending_binding_${host}`);
  if (!pending) throw invalid(`no pending binding for host ${host}; run pm capture setup ${host}`);
  const p = JSON.parse(pending) as { bindingId: string; generation: string };
  if (p.generation !== project.identity.generation) {
    throw invalid("binding belongs to a retired project generation");
  }
  if (p.bindingId !== bindingId) throw invalid("binding id does not match the registered pending binding");
  setMeta(
    project.db,
    `observed_binding_${host}`,
    JSON.stringify({ bindingId, generation: project.identity.generation, observedAt: nowIso() }),
  );
}
