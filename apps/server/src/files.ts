// Files and commits the dashboard may show (PROTOCOL.md, "Files and commits"): the file viewer and the review material's
// links read files through GET /api/projects/:id/file, a commit's details come from GET /api/projects/:id/commits/:hash.
//
// A path is taken relative to the project's root (not the server's working folder), then must lie under one of the
// allowed roots (the project, its worktree directory, a session's working directory) both as written and after its
// links are followed, so a symlink or junction pointing out is refused. A `..` segment is refused outright, and so is
// a network (UNC) or device path, before anything touches the disk. Everything served is data: every response carries
// a Content-Security-Policy that sandboxes it, so an SVG or HTML file opened from the dashboard's origin runs nothing.
// Text over 1 MB is cut (at a line end) and says so in a header; pictures and PDFs are served whole; other binary files
// are offered as a download, never shown.
import { closeSync, createReadStream, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { git } from "./gitinfo.ts";

/** Text longer than this is cut (DESIGN.md, the file viewer: files over 1 MB are cut with a note). */
export const MAX_TEXT = 1024 * 1024;

/**
 * Sent with every file: no script, no plugin, no form, a unique origin (sandbox). Pictures (an SVG's own) and inline
 * styles may load so an SVG still draws itself. PDFs, which Chromium's viewer cannot show in a sandboxed document, get
 * the same policy without `sandbox`: default-src 'none' still lets nothing in the file run or load.
 */
export const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
export const PDF_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

export const PICTURES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
/** Text types worth naming; any other file without NUL bytes in its first 8 KB is served as plain text. */
const TEXT: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8",
};
const PLAIN = "text/plain; charset=utf-8";

export type Located = { real: string } | { status: 400 | 403 | 404; error: string };

const inside = (p: string, roots: readonly string[]) => {
  const l = p.toLowerCase();
  return roots.some((r) => l === r || l.startsWith(r + "\\") || l.startsWith(r + "/"));
};
const lower = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();

/**
 * Where a requested path lies, or why it is refused. `roots` are the allowed roots as configured; they are compared
 * both as written and with their links followed (an allowed root may itself be reached through a junction).
 */
export function locate(projectRoot: string, roots: readonly string[], path: string): Located {
  if (!path || path.includes("\0")) return { status: 400, error: "no path" };
  // A UNC or device path (\\server\share, \\?\C:\…, //server) would make Windows reach out before any check could.
  if (/^[\\/]{2}/.test(path)) return { status: 403, error: "outside the project" };
  if (path.split(/[\\/]/).includes("..")) return { status: 403, error: "a path with .. is not followed" };
  const abs = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  const real = roots.flatMap((r) => { try { return [lower(realpathSync(r))]; } catch { return []; } });
  if (!inside(abs, [...roots.map(lower), ...real])) return { status: 403, error: "outside the project" };
  let found: string;
  try { found = realpathSync(abs); } catch { return { status: 404, error: "not found" }; }
  if (!inside(found, real)) return { status: 403, error: "outside the project" };
  return { real: found };
}

/** The first `n` bytes of a file. */
function head(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally { closeSync(fd); }
}

/** Cut text at the last line end within the limit; without one, at the last whole UTF-8 character. */
export function cutText(buf: Buffer): Buffer {
  const nl = buf.lastIndexOf(0x0a);
  if (nl > 0) return buf.subarray(0, nl + 1);
  // The last character starts at its lead byte (not 10xxxxxx); keep it only when all its bytes are there.
  let start = buf.length - 1;
  while (start > 0 && (buf[start]! & 0xc0) === 0x80) start--;
  const lead = buf[start] ?? 0;
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.subarray(0, start + size <= buf.length ? buf.length : start);
}

const stream = (path: string) => Readable.toWeb(createReadStream(path)) as ReadableStream;

/**
 * The response for a located file. Headers: `x-nexus-size` (the whole file's bytes), `x-nexus-truncated: 1` when the
 * text was cut, `x-nexus-kind` (text, picture, pdf or binary) for the viewer.
 */
export function fileResponse(real: string): Response {
  const stat = statSync(real);
  if (!stat.isFile()) return Response.json({ error: "not a file" }, { status: 404 });
  const ext = extname(real).toLowerCase();
  const base = { "cache-control": "no-cache", "x-content-type-options": "nosniff", "x-nexus-size": String(stat.size) };
  const sandboxed = { ...base, "content-security-policy": FILE_CSP };
  const picture = PICTURES[ext];
  if (picture) return new Response(stream(real), { headers: { ...sandboxed, "content-type": picture, "x-nexus-kind": "picture" } });
  if (ext === ".pdf") {
    return new Response(stream(real), { headers: { ...base, "content-security-policy": PDF_CSP, "content-type": "application/pdf", "x-nexus-kind": "pdf" } });
  }
  const first = head(real, Math.min(stat.size, MAX_TEXT + 1));
  if (!TEXT[ext] && first.subarray(0, 8192).includes(0)) {
    return new Response(stream(real), {
      headers: { ...sandboxed, "content-type": "application/octet-stream", "content-disposition": "attachment", "x-nexus-kind": "binary" },
    });
  }
  const cut = stat.size > MAX_TEXT;
  const body = cut ? cutText(first.subarray(0, MAX_TEXT)) : first;
  return new Response(new Uint8Array(body), {
    headers: { ...sandboxed, "content-type": TEXT[ext] ?? PLAIN, "x-nexus-kind": "text", ...(cut ? { "x-nexus-truncated": "1" } : {}) },
  });
}

// ---------------------------------------------------------------- commits

/** A commit hash as the dashboard may ask for it: 7 to 40 lowercase hex digits, nothing else reaches git. */
export const COMMIT_HASH = /^[0-9a-f]{7,40}$/;

export interface CommitFile { path: string; insertions: number | null; deletions: number | null }
export interface CommitDetail {
  sha: string; subject: string; author: string; at: string;
  files: CommitFile[]; insertions: number; deletions: number;
}

const SEP = "\x1f";
/**
 * One commit by its hash, from the repository at `dir` (local git only): its subject, author, date and diffstat (a
 * merge against its first parent; a binary file's lines are null). Undefined for a hash that is not one commit
 * (unknown, ambiguous, or not a commit).
 */
export function commitDetail(dir: string, hash: string): CommitDetail | undefined {
  if (!COMMIT_HASH.test(hash)) return undefined;
  const out = git(dir, ["show", "--no-color", "--no-ext-diff", "--numstat", "--diff-merges=first-parent",
    `--format=@@${SEP}%H${SEP}%aI${SEP}%an${SEP}%s`, `${hash}^{commit}`, "--"]);
  if (!out) return undefined;
  const [first, ...rest] = out.split(/\r?\n/);
  if (!first?.startsWith(`@@${SEP}`)) return undefined;
  const [, sha, at, author, subject] = first.split(SEP);
  const c: CommitDetail = { sha: sha!, subject: subject ?? "", author: author ?? "", at: new Date(at!).toISOString(), files: [], insertions: 0, deletions: 0 };
  for (const line of rest) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
    if (!m) continue;
    const ins = m[1] === "-" ? null : Number(m[1]);
    const del = m[2] === "-" ? null : Number(m[2]);
    c.files.push({ path: m[3]!, insertions: ins, deletions: del });
    c.insertions += ins ?? 0;
    c.deletions += del ?? 0;
  }
  return c;
}
