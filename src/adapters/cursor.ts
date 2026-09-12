import type { Adapter, ParsedTranscript } from "./types.ts";
import type { NormalizedEvent, RetainedRole } from "../lib/ingest.ts";
import { invalid } from "../lib/util.ts";

/**
 * Cursor transcript adapter (pinned surface: hook-supplied transcript JSON with
 * conversation and generation IDs and a message list).
 *
 * Cursor's separate `thought` message type is explicitly discarded (review
 * finding R4). Disabled transcripts, Tab and cloud surfaces are NOT supported
 * — a missing/null transcript is partial coverage, reported by the CLI.
 * Generation IDs map to lineage: a new generation id starts a new lineage.
 */

type CursorTranscript = {
  conversationId?: string;
  messages?: {
    id?: string;
    generationId?: string;
    role?: string;
    type?: string;
    content?: string;
  }[];
};

export const cursorAdapter: Adapter = {
  name: "cursor",
  version: "1",
  parse(content: string, sourceIdentity: string): ParsedTranscript {
    let doc: CursorTranscript;
    try {
      doc = JSON.parse(content) as CursorTranscript;
    } catch {
      throw invalid("cursor transcript is not valid JSON");
    }
    if (!doc.conversationId || !Array.isArray(doc.messages)) {
      throw invalid("cursor transcript missing conversationId or messages");
    }
    const events: NormalizedEvent[] = [];
    const warnings: string[] = [];
    let ord = 0;
    let discarded = 0;
    for (const m of doc.messages) {
      ord++;
      if (m.type === "thought") {
        discarded++;
        continue; // hidden reasoning: never retained
      }
      let role: RetainedRole | undefined;
      if (m.role === "user") role = "user";
      else if (m.role === "assistant") role = "assistant";
      else continue;
      if (typeof m.content !== "string" || !m.content.trim()) continue;
      events.push({
        lineage: m.generationId ? `${doc.conversationId}/gen-${m.generationId}` : `${doc.conversationId}/main`,
        sourceEvent: m.id ?? `ord-${ord}`,
        revision: 0,
        ord,
        role,
        content: m.content,
      });
    }
    if (discarded > 0) warnings.push(`${discarded} thought/internal messages discarded (never retained)`);
    return {
      spec: {
        adapter: "cursor",
        adapterVersion: "1",
        sourceSession: doc.conversationId,
        sourceIdentity,
      },
      events,
      coverageStatus: "complete",
      warnings,
    };
  },
};
