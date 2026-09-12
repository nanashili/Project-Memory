import type { NormalizedEvent, SessionSpec } from "../lib/ingest.ts";

export type ParsedTranscript = {
  spec: SessionSpec;
  events: NormalizedEvent[];
  /** honest coverage statement: complete within retained classes, or unverified */
  coverageStatus: "complete" | "unverified";
  warnings: string[];
};

export type Adapter = {
  name: string;
  version: string;
  parse(content: string, sourceIdentity: string): ParsedTranscript;
};
