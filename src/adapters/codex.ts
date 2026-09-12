import type { Adapter, ParsedTranscript } from "./types.ts";
import type { NormalizedEvent, RetainedRole } from "../lib/ingest.ts";
import { invalid, truncateUtf8 } from "../lib/util.ts";

/**
 * Codex rollout JSONL adapter (pinned surface: rollout transcript files with
 * one JSON object per line: {timestamp, type, payload}).
 *
 * Retained: session_meta (session id), response_item message user/assistant
 * text, function_call inputs and bounded function_call_output results.
 * Reasoning items and unknown payload types are discarded. A SessionEnd
 * callback alone cannot prove final capture — coverage is what this file
 * contains, reconciled by replay.
 */

type CodexLine = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b !== "object" || b === null) return "";
      const r = b as Record<string, unknown>;
      if ((r.type === "input_text" || r.type === "output_text" || r.type === "text") && typeof r.text === "string") {
        return r.text;
      }
      return "";
    })
    .filter((t) => t.length > 0)
    .join("\n");
}

export const codexAdapter: Adapter = {
  name: "codex",
  version: "1",
  parse(content: string, sourceIdentity: string): ParsedTranscript {
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw invalid("empty rollout file");
    let sessionId: string | undefined;
    const events: NormalizedEvent[] = [];
    const warnings: string[] = [];
    let malformed = 0;
    let ord = 0;
    for (const line of lines) {
      ord++;
      let rec: CodexLine;
      try {
        rec = JSON.parse(line) as CodexLine;
      } catch {
        malformed++;
        continue;
      }
      const payload = rec.payload ?? {};
      if (rec.type === "session_meta") {
        const id = payload.id;
        if (typeof id === "string") sessionId = id;
        continue;
      }
      if (rec.type !== "response_item") continue; // event_msg, compacted, unknown: discarded
      const ptype = payload.type;
      let role: RetainedRole | undefined;
      let text = "";
      if (ptype === "message") {
        const r = payload.role;
        if (r === "user") role = "user";
        else if (r === "assistant") role = "assistant";
        else continue; // system/developer prompts are host-internal
        text = textOfContent(payload.content);
      } else if (ptype === "function_call") {
        role = "tool_input";
        const name = typeof payload.name === "string" ? payload.name : "unknown-tool";
        const [args] = truncateUtf8(String(payload.arguments ?? ""), 8 * 1024);
        text = `[tool:${name}] ${args}`;
      } else if (ptype === "function_call_output") {
        role = "tool_result";
        const output = payload.output;
        const raw =
          typeof output === "string"
            ? output
            : typeof output === "object" && output !== null
              ? String((output as Record<string, unknown>).content ?? "")
              : "";
        [text] = truncateUtf8(raw, 8 * 1024);
      } else {
        continue; // reasoning and unknown payloads: discarded
      }
      if (!role || !text.trim()) continue;
      const eventId =
        typeof payload.id === "string" && payload.id.length > 0 ? payload.id : `ord-${ord}`;
      events.push({
        lineage: "main",
        sourceEvent: eventId,
        revision: 0,
        ord,
        role,
        content: text,
      });
    }
    if (!sessionId) throw invalid("rollout has no session_meta with id");
    if (malformed > 0) warnings.push(`${malformed} malformed lines skipped (coverage gap)`);
    return {
      spec: { adapter: "codex", adapterVersion: "1", sourceSession: sessionId, sourceIdentity },
      events,
      coverageStatus: malformed > 0 ? "unverified" : "complete",
      warnings,
    };
  },
};
