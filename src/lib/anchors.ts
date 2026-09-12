import type { Project } from "./project.ts";
import { safeReadFile, assertWithinRoot, splitRootRelative } from "./safeio.ts";
import { invalid, sha256Hex, truncateUtf8, LIMITS } from "./util.ts";
import { blobOidAtHead, headOid, isFileDirty } from "./git.ts";

/**
 * Exact versioned code anchor. Dirty files use their actual content digest and
 * worktree identity plus a base commit when available; HEAD is never labeled
 * as the version of uncommitted bytes.
 */
export type CodeAnchor = {
  path: string; // root-relative, forward slashes
  commitOid?: string; // present only when the file is clean at this commit
  blobOid?: string;
  contentDigest: string; // sha256 of full file bytes at capture
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  objectFormat?: string;
  worktree?: string;
};

export function anchorForFile(project: Project, file: string, lineStart: number, lineEnd: number): CodeAnchor {
  if (lineStart < 1 || lineEnd < lineStart) throw invalid(`invalid line range ${lineStart}:${lineEnd}`);
  const root = project.identity.root;
  const abs = assertWithinRoot(root, file);
  const relPath = splitRootRelative(root, abs);
  const read = safeReadFile(root, abs);
  const contentDigest = sha256Hex(read.content);
  const lines = read.content.split("\n");
  if (lineStart > lines.length) throw invalid(`line ${lineStart} beyond end of ${relPath} (${lines.length} lines)`);
  const end = Math.min(lineEnd, lines.length);
  const [excerpt] = truncateUtf8(lines.slice(lineStart - 1, end).join("\n"), LIMITS.maxExcerptBytes);

  const anchor: CodeAnchor = {
    path: relPath,
    contentDigest,
    lineStart,
    lineEnd: end,
    excerpt,
  };
  if (project.git.isRepo && !project.git.enrichmentDisabled) {
    anchor.objectFormat = project.git.objectFormat;
    anchor.worktree = root;
    const dirty = isFileDirty(root, relPath);
    if (!dirty) {
      const head = headOid(root);
      const blob = blobOidAtHead(root, relPath);
      if (head && blob) {
        anchor.commitOid = head;
        anchor.blobOid = blob;
      }
    }
  } else {
    anchor.worktree = root;
  }
  return anchor;
}

export type Applicability =
  | { status: "current"; detail: string }
  | { status: "historical"; detail: string }
  | { status: "missing"; detail: string }
  | { status: "ambiguous"; detail: string };

/**
 * Derived at query time, never stored. Compares the stored content version
 * against the actual current file in the checked view.
 */
export function checkApplicability(
  project: Project,
  source: { path: string | null; content_digest: string | null; line_start: number | null; line_end: number | null },
): Applicability {
  if (!source.path || !source.content_digest) {
    return { status: "ambiguous", detail: "source has no code anchor" };
  }
  const root = project.identity.root;
  let read;
  try {
    read = safeReadFile(root, source.path);
  } catch {
    return { status: "missing", detail: `file no longer present: ${source.path}` };
  }
  const digest = sha256Hex(read.content);
  if (digest === source.content_digest) {
    return { status: "current", detail: "exact source version matches this checked view" };
  }
  return {
    status: "historical",
    detail: `file changed since capture; anchor refers to the historical version (digest ${source.content_digest.slice(0, 12)}…)`,
  };
}

/** Digest of the current file for view identity in packets. */
export function currentFileDigest(project: Project, relPath: string): string | undefined {
  try {
    const read = safeReadFile(project.identity.root, relPath);
    return sha256Hex(read.content);
  } catch {
    return undefined;
  }
}
