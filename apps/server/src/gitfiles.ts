// Git's refs read from the files of a checkout's .git, without a git process (queue GB): the HEAD's commit, a ref's
// value, the branch a checkout is on. A step's boundary read these with `git rev-parse` and `git branch`, a process of
// 50 ms each on a quiet machine and several hundred beside the test suite, while the event loop waited
// (docs/design/performance.md, "The step boundary's reads from the .git files").
//
// Only what the files answer exactly as git would; for anything else the reader says it cannot tell (undefined) and the
// caller asks git, as before:
// - the checkout's .git: a folder (a main checkout), or a file `gitdir: <path>` (a worktree, a submodule), whose
//   folder names the shared one in `commondir`;
// - a ref: a loose file (`<sha>` or `ref: <other ref>`, followed to MAX_DEPTH like git), else a line of `packed-refs`;
//   refs of the worktree's own (HEAD, the pseudo-refs such as MERGE_HEAD, refs/worktree/, refs/bisect/,
//   refs/rewritten/) in its own folder, the rest in the shared one.
// Git is asked instead when the checkout has no .git of its own (git would look in the folders above), when GIT_DIR or
// another variable that moves the repository is set, for the reftable ref storage, for a file that cannot be read or
// says something unexpected, and for a ref name that is not a full one.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** How many symbolic refs git follows before it gives up (refs.c, SYMREF_MAXDEPTH). */
const MAX_DEPTH = 5;
/** Variables that make git look for the repository elsewhere than the checkout's .git. */
const MOVED = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE", "GIT_REF_STORAGE"];
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Refs a worktree keeps in its own folder (git's per-worktree refs). */
const PER_WORKTREE = /^(?:[A-Z][A-Z0-9_]*$|refs\/(?:worktree|bisect|rewritten)\/)/;

interface GitDirs { git: string; common: string }

/** A file's text, null when it does not exist; undefined when it cannot be read (in use, a folder, no access). */
function read(file: string): string | null | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined;
  }
}

/** The checkout's own git folder and the shared one; undefined when the files cannot say it as git would. */
function dirsOf(cwd: string): GitDirs | undefined {
  if (MOVED.some((v) => process.env[v])) return undefined;
  const dotGit = join(cwd, ".git");
  let git: string;
  try {
    if (statSync(dotGit).isDirectory()) git = dotGit;
    else {
      const m = /^gitdir: (.+?)\s*$/.exec(read(dotGit) ?? "");
      if (!m) return undefined;
      git = isAbsolute(m[1]!) ? m[1]! : resolve(cwd, m[1]!);
      if (!statSync(git).isDirectory()) return undefined;
    }
  } catch { return undefined; }
  const commondir = read(join(git, "commondir"));
  if (commondir === undefined) return undefined;
  const common = commondir === null ? git : resolve(git, commondir.trim());
  // The reftable storage keeps refs in a format of its own.
  try { if (statSync(join(common, "reftable")).isDirectory()) return undefined; } catch { /* the files storage */ }
  return { git, common };
}

/** The value of the ref `name` (a full name: HEAD, MERGE_HEAD, refs/heads/main): a sha, null when there is none. */
function resolveRef(dirs: GitDirs, name: string, depth = 0): string | null | undefined {
  if (depth > MAX_DEPTH || !/^(?:[A-Z][A-Z0-9_]*|refs\/.+)$/.test(name) || name.split("/").some((p) => p === "" || p === "." || p === "..")) return undefined;
  const loose = read(join(PER_WORKTREE.test(name) ? dirs.git : dirs.common, name));
  if (loose === undefined) return undefined;
  if (loose !== null) {
    const first = loose.split(/\r?\n/)[0]!.trim();
    if (first.startsWith("ref:")) return resolveRef(dirs, first.slice(4).trim(), depth + 1);
    // A pseudo-ref such as MERGE_HEAD may list several commits (an octopus merge), one per line: git takes the first.
    const sha = first.split(/\s/)[0]!;
    return SHA.test(sha) ? sha : undefined;
  }
  if (PER_WORKTREE.test(name)) return null;
  return packed(dirs.common, name);
}

/** The ref's line in packed-refs: its sha, null when it is not there. */
function packed(common: string, name: string): string | null | undefined {
  const text = read(join(common, "packed-refs"));
  if (text === undefined) return undefined;
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const at = line.indexOf(" ");
    if (line.slice(at + 1) !== name) continue;
    const sha = line.slice(0, at);
    return SHA.test(sha) ? sha : undefined;
  }
  return null;
}

/**
 * What `git rev-parse <name>` gives in `cwd` for a full ref name (HEAD, MERGE_HEAD, refs/heads/main), read from the
 * files: `{ sha }`, with null where git fails (no such ref, a branch without a commit yet); undefined when the files
 * cannot tell, and git is to be asked.
 */
export function refFromFiles(cwd: string, name: string): { sha: string | null } | undefined {
  const dirs = dirsOf(cwd);
  if (!dirs) return undefined;
  const sha = resolveRef(dirs, name);
  return sha === undefined ? undefined : { sha };
}

/**
 * What `git branch --show-current` gives in `cwd`, read from the files: `{ branch }`, null on a detached HEAD;
 * undefined when the files cannot tell.
 */
export function branchFromFiles(cwd: string): { branch: string | null } | undefined {
  const dirs = dirsOf(cwd);
  const head = dirs && read(join(dirs.git, "HEAD"));
  if (!head) return undefined;
  const first = head.split(/\r?\n/)[0]!.trim();
  if (!first.startsWith("ref:")) return SHA.test(first) ? { branch: null } : undefined;
  const ref = first.slice(4).trim();
  // `branch --show-current` names only a branch; HEAD pointing elsewhere (a rare hand-made state) is left to git.
  return ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length ? { branch: ref.slice("refs/heads/".length) } : undefined;
}
