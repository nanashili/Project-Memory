import { openSync, fstatSync, lstatSync, readSync, closeSync, constants } from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { invalid, LIMITS, PmError } from "./util.ts";

/**
 * Safe file admission: reject symlinks in admitted path components below the
 * approved root, open without following links, verify the descriptor refers to
 * the same regular file, and stream with a byte limit.
 *
 * This defends the evidence path against symlink swaps between admission and
 * read. It is not isolation against an unrestricted same-user process (design
 * boundary, stated in the docs).
 */

export function assertWithinRoot(root: string, candidate: string): string {
  const abs = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const rel = relative(root, abs);
  if (rel === "" || rel === ".") throw invalid("path resolves to the root itself");
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PmError("path-escape", `path escapes approved root: ${candidate}`, 1);
  }
  return abs;
}

/** Reject symlinks and non-regular files in every component below `root`. */
function assertNoSymlinkComponents(root: string, absPath: string): void {
  let current = absPath;
  const stack: string[] = [];
  while (current !== root && current !== dirname(current)) {
    stack.push(current);
    current = dirname(current);
  }
  if (current !== root) throw invalid(`path not under approved root: ${absPath}`);
  for (const component of stack.reverse()) {
    const st = lstatSync(component, { throwIfNoEntry: true });
    if (st.isSymbolicLink()) {
      throw new PmError("symlink-rejected", `symlink in admitted path: ${component}`, 1);
    }
    if (component === absPath && !st.isFile()) {
      throw new PmError("not-regular-file", `not a regular file: ${component}`, 1);
    }
  }
}

export type SafeReadResult = {
  content: string;
  bytes: number;
  truncated: boolean;
  /** identity of the bytes actually read */
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

/**
 * Open with O_NOFOLLOW after componentwise lstat admission; verify fstat
 * matches lstat identity (same dev/ino, regular file); bounded read from the
 * validated descriptor.
 */
export function safeReadFile(
  root: string,
  candidate: string,
  maxBytes: number = LIMITS.maxImportFileBytes,
): SafeReadResult {
  const abs = assertWithinRoot(root, candidate);
  assertNoSymlinkComponents(root, abs);
  const pre = lstatSync(abs);
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    throw new PmError("open-failed", `cannot safely open ${candidate}: ${String((e as Error).message)}`, 1);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PmError("not-regular-file", `not a regular file: ${candidate}`, 1);
    if (st.dev !== pre.dev || st.ino !== pre.ino) {
      throw new PmError("file-replaced", `file replaced between admission and open: ${candidate}`, 1);
    }
    const cap = Math.min(Number(st.size), maxBytes + 1);
    const buf = Buffer.alloc(cap);
    let off = 0;
    while (off < cap) {
      const n = readSync(fd, buf, off, cap - off, off);
      if (n <= 0) break;
      off += n;
    }
    const post = fstatSync(fd);
    if (post.ino !== st.ino || post.dev !== st.dev) {
      throw new PmError("file-replaced", `file changed during read: ${candidate}`, 1);
    }
    const truncated = off > maxBytes;
    const used = Math.min(off, maxBytes);
    return {
      content: buf.subarray(0, used).toString("utf8"),
      bytes: used,
      truncated,
      dev: st.dev,
      ino: st.ino,
      size: Number(st.size),
      mtimeMs: st.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

/** Same admission policy for explicitly selected import files (outside the repo). */
export function safeReadSelectedFile(absPath: string, maxBytes: number): SafeReadResult {
  if (!isAbsolute(absPath)) throw invalid("import file must be an absolute path");
  const pre = lstatSync(absPath, { throwIfNoEntry: true });
  if (pre.isSymbolicLink()) throw new PmError("symlink-rejected", `refusing symlink import: ${absPath}`, 1);
  if (!pre.isFile()) throw new PmError("not-regular-file", `not a regular file: ${absPath}`, 1);
  if (Number(pre.size) > maxBytes) {
    throw new PmError("capacity", `import file exceeds ${maxBytes} byte limit`, 5);
  }
  return safeReadFile(dirname(absPath), absPath, maxBytes);
}

export function splitRootRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
