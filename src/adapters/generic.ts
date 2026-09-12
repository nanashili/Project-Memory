import type { Adapter, ParsedTranscript } from "./types.ts";
import { isRetainedRole, type NormalizedEvent } from "../lib/ingest.ts";
import { invalid } from "../lib/util.ts";

/**
 * Explicit transcript import format (JSONL):
 *   {"type":"header","adapter":"generic","session":"...","lineage":"main"}
 *   {"type":"event","event_id":"e1","role":"user","content":"...","revision":0,"lineage":"main"}
 * Unknown event types and unknown text-bearing fields are discarded, not
 * merged into metadata.
 */
export const genericAdapter: Adapter = {
  name: "generic",
  version: "1",
  parse(content: string, sourceIdentity: string): ParsedTranscript {
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw invalid("empty import file");
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(lines[0]!) as Record<string, unknown>;
    } catch {
      throw invalid("first line is not valid JSON");
    }
    if (header.type !== "header" || typeof header.session !== "string") {
      throw invalid('first line must be {"type":"header","session":...}');
    }
    const defaultLineage = typeof header.lineage === "string" ? header.lineage : "main";
    const events: NormalizedEvent[] = [];
    const warnings: string[] = [];
    let malformed = 0;
    for (let i = 1; i < lines.length; i++) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(lines[i]!) as Record<string, unknown>;
      } catch {
        malformed++;
        continue; // terminal malformed record: content-free diagnostic + gap
      }
      if (rec.type !== "event") continue;
      const role = String(rec.role ?? "");
      if (!isRetainedRole(role)) continue; // closed retained classes
      if (typeof rec.content !== "string" || typeof rec.event_id !== "string") {
        malformed++;
        continue;
      }
      events.push({
        lineage: typeof rec.lineage === "string" ? rec.lineage : defaultLineage,
        sourceEvent: rec.event_id,
        revision: typeof rec.revision === "number" ? rec.revision : 0,
        ord: i,
        role,
        content: rec.content,
      });
    }
    if (malformed > 0) {
      warnings.push(`${malformed} malformed/unsupported records skipped (coverage gap)`);
    }
    return {
      spec: {
        adapter: "generic",
        adapterVersion: "1",
        sourceSession: header.session,
        sourceIdentity,
      },
      events,
      coverageStatus: malformed > 0 ? "unverified" : "complete",
      warnings,
    };
  },
};
