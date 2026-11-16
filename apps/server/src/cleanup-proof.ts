// A deletion may remove only an unchanged subset of the tree verified before it began. No recursive deletion:
// every entry is checked again immediately before unlink/rmdir; links are recorded, never followed.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ActionError, type GitFile } from "@nexus/protocol";

type Proof = NonNullable<GitFile["cleanup_proof"]>;
type Entry = Proof["entries"][number];

export function cleanupRefusal(path: string, reason: string): never {
  throw new ActionError(`cleanup evidence for ${path} is insufficient: ${reason}. Preserve the remaining folder outside the worktree path, inspect it against the merged commit and recover any work; then retry Clean up with the original path absent. Do not recreate .git or fabricate cleanup evidence`, 409);
}

/** ENOENT alone means absent; permission errors and dangling links do not. */
function stat(path: string) {
  try { return lstatSync(path, { bigint: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}

export function cleanupIdentity(path: string): string {
  const s = stat(path);
  if (!s || s.isSymbolicLink() || !s.isDirectory() || s.ino === 0n) return cleanupRefusal(path, "directory identity cannot be established");
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}

function entry(path: string, name: string): Entry | undefined {
  const s = stat(path);
  if (!s) return undefined;
  const kind = s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : s.isFile() ? "file" : undefined;
  if (!kind || s.ino === 0n) return cleanupRefusal(path, "unsupported file type or missing file identity");
  const identity = `${s.dev}:${s.ino}:${s.birthtimeNs}`;
  if (kind === "directory") return { path: name, kind, identity };
  const digest = createHash("sha256").update(kind === "link" ? readlinkSync(path) : readFileSync(path)).digest("hex");
  return { path: name, kind, identity, digest, modified: `${s.mtimeNs}:${s.ctimeNs}:${s.mode}` };
}

/** Includes ignored files and empty directories, and the .git pointer. */
export function cleanupSnapshot(path: string): Entry[] {
  const entries: Entry[] = [];
  const visit = (name: string) => {
    const item = entry(join(path, name), name);
    if (!item) return;
    entries.push(item);
    if (item.kind === "directory") for (const child of readdirSync(join(path, name)).sort()) visit(name ? `${name}/${child}` : child);
  };
  visit("");
  if (entries.length && entries[0]!.kind !== "directory") cleanupRefusal(path, "the target is not a directory");
  return entries;
}

function equal(a: Entry, b: Entry): boolean {
  return a.kind === b.kind && a.identity === b.identity && a.digest === b.digest && a.modified === b.modified;
}

/** The canonical path prevents an ancestor replaced by a junction from redirecting deletion. */
export function cleanupPath(path: string): string {
  return stat(path) ? realpathSync(path) : join(cleanupPath(dirname(path)), relative(dirname(path), path));
}

type RemovalIO = { unlink?: typeof unlinkSync; rmdir?: typeof rmdirSync; retries?: number };

export function removeVerifiedTree(path: string, proof: Proof, io: RemovalIO = {}): void {
  for (let attempt = 0; ; attempt++) {
    try { removeAttempt(path, proof, io); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= (io.retries ?? 8) || !code || !["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"].includes(code)) throw e;
      // Git and Node's former recursive fallback both retried transient Windows locks. Retry the proof check too,
      // not just the failed syscall: a new file or changed identity must still stop this attempt.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (attempt + 1));
    }
  }
}

function removeAttempt(path: string, proof: Proof, io: RemovalIO): void {
  if (resolve(path).toLowerCase() !== resolve(proof.path).toLowerCase()
    || cleanupPath(path).toLowerCase() !== proof.path.toLowerCase()) cleanupRefusal(path, "the canonical target path changed");
  const expected = new Map(proof.entries.map((item) => [item.path, item]));
  const current = cleanupSnapshot(path);
  // Preflight the entire remainder before deleting anything on this attempt.
  for (const item of current) {
    const saved = expected.get(item.path);
    if (!saved || !equal(item, saved)) cleanupRefusal(join(path, item.path), "new, modified or replaced content since cleanup began");
  }
  for (const saved of current.reverse()) {
    // Check the parent chain too: never traverse a directory that was replaced after preflight.
    let parent = dirname(saved.path);
    while (true) {
      const name = parent === "." ? "" : parent.replaceAll("\\", "/");
      const actual = entry(join(path, name), name), original = expected.get(name);
      if (!actual || !original || !equal(actual, original)) cleanupRefusal(path, "a parent directory changed during cleanup");
      if (!name) break;
      parent = dirname(name);
    }
    const target = join(path, saved.path);
    const actual = entry(target, saved.path);
    if (!actual) continue;
    if (!equal(actual, saved)) cleanupRefusal(target, "content changed during cleanup");
    // Nonrecursive rmdir refuses any newly arrived children, including ignored files.
    if (saved.kind === "directory") (io.rmdir ?? rmdirSync)(target);
    else (io.unlink ?? unlinkSync)(target);
  }
}
