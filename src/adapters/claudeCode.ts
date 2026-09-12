import type { Adapter, ParsedTranscript } from "./types.ts";
import type { NormalizedEvent, RetainedRole } from "../lib/ingest.ts";
import { invalid, truncateUtf8, LIMITS } from "../lib/util.ts";

/**
 * Claude Code transcript JSONL adapter (pinned surface: transcript files with
 * one JSON object per line carrying uuid/parentUuid/sessionId/message).
 *
 * Lineage: the transcript is a tree via parentUuid. The first-created chain is
 * lineage "main"; every fork (a parent with more than one child) starts an
 * isolated lineage keyed by the forking child's uuid. Approval never crosses
 * lineages. Unknown ancestry (missing parent) starts an unverified lineage.
 *
 * Retained classes: visible user text, visible assistant text, tool_use inputs
 * and bounded tool results. `thinking` blocks and unknown block types are
 * discarded entirely.
 */

type CcLine = {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  message?: { role?: string; content?: unknown };
  toolUseResult?: unknown;
};

function extractContent(message: { role?: string; content?: unknown }): {
  role: RetainedRole;
  content: string;
}[] {
  const out: { role: RetainedRole; content: string }[] = [];
  const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : undefined;
  if (!role) return out;
  const c = message.content;
  if (typeof c === "string") {
    if (c.trim()) out.push({ role, content: c });
    return out;
  }
  if (!Array.isArray(c)) return out;
  for (const block of c) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push({ role, content: b.text });
    } else if (b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "unknown-tool";
      const [input] = truncateUtf8(JSON.stringify(b.input ?? {}), 8 * 1024);
      out.push({ role: "tool_input", content: `[tool:${name}] ${input}` });
    } else if (b.type === "tool_result") {
      const inner = b.content;
      let text = "";
      if (typeof inner === "string") text = inner;
      else if (Array.isArray(inner)) {
        text = inner
          .map((x) =>
            typeof x === "object" && x !== null && (x as Record<string, unknown>).type === "text"
              ? String((x as Record<string, unknown>).text ?? "")
              : "",
          )
          .join("\n");
      }
      if (text.trim()) {
        const [bounded] = truncateUtf8(text, 8 * 1024);
        out.push({ role: "tool_result", content: bounded });
      }
    }
    // thinking / redacted_thinking / unknown types: discarded
  }
  return out;
}

export const claudeCodeAdapter: Adapter = {
  name: "claude-code",
  version: "1",
  parse(content: string, sourceIdentity: string): ParsedTranscript {
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw invalid("empty transcript");
    const records: CcLine[] = [];
    let malformed = 0;
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as CcLine);
      } catch {
        malformed++;
      }
    }
    const messages = records.filter(
      (r) => (r.type === "user" || r.type === "assistant") && r.uuid && r.message,
    );
    if (messages.length === 0) throw invalid("no visible messages in transcript");
    const sessionId = messages.find((m) => m.sessionId)?.sessionId;
    if (!sessionId) throw invalid("transcript has no sessionId");

    // Build the tree and assign lineages.
    const childrenOf = new Map<string | null, CcLine[]>();
    const byUuid = new Map<string, CcLine>();
    for (const m of messages) {
      byUuid.set(m.uuid!, m);
      const p = m.parentUuid ?? null;
      const arr = childrenOf.get(p) ?? [];
      arr.push(m);
      childrenOf.set(p, arr);
    }
    const lineageOf = new Map<string, string>();
    const unverified = new Set<string>();
    const warnings: string[] = [];

    // roots: parent null, or parent not present in this transcript (unknown ancestry)
    const roots: CcLine[] = [];
    for (const m of messages) {
      const p = m.parentUuid ?? null;
      if (p === null) roots.push(m);
      else if (!byUuid.has(p)) {
        roots.push(m);
        unverified.add(m.uuid!);
        warnings.push(`unknown ancestry for ${m.uuid}: isolated unverified lineage`);
      }
    }
    const queue: { node: CcLine; lineage: string }[] = [];
    roots.forEach((r, i) => {
      const lineage =
        i === 0 && !unverified.has(r.uuid!) ? `${sessionId}/main` : `${sessionId}/root-${r.uuid}`;
      queue.push({ node: r, lineage });
    });
    while (queue.length > 0) {
      const { node, lineage } = queue.shift()!;
      lineageOf.set(node.uuid!, lineage);
      const kids = childrenOf.get(node.uuid!) ?? [];
      kids.forEach((kid, i) => {
        // first child continues the lineage; siblings are forks
        const kidLineage = i === 0 ? lineage : `${sessionId}/fork-${kid.uuid}`;
        if (i > 0) warnings.push(`fork at ${node.uuid}: child ${kid.uuid} starts isolated lineage`);
        queue.push({ node: kid, lineage: kidLineage });
      });
    }

    const events: NormalizedEvent[] = [];
    let ord = 0;
    for (const m of messages) {
      ord++;
      const lineage = lineageOf.get(m.uuid!) ?? `${sessionId}/orphan-${m.uuid}`;
      const parts = extractContent(m.message!);
      parts.forEach((p, i) => {
        const ev: NormalizedEvent = {
          lineage,
          sourceEvent: parts.length === 1 ? m.uuid! : `${m.uuid}#${i}`,
          revision: 0,
          ord: ord * 100 + i,
          role: p.role,
          content: p.content,
        };
        if (unverified.has(m.uuid!)) ev.meta = { unverified_ancestry: true };
        events.push(ev);
      });
    }
    if (malformed > 0) warnings.push(`${malformed} malformed lines skipped (coverage gap)`);
    return {
      spec: {
        adapter: "claude-code",
        adapterVersion: "1",
        sourceSession: sessionId,
        sourceIdentity,
      },
      events,
      coverageStatus: malformed > 0 || unverified.size > 0 ? "unverified" : "complete",
      warnings,
    };
  },
};
