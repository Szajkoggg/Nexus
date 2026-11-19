// The layout of the documents split by topic (docs/doc-split-plan.md): an index file (docs/PROTOCOL.md) with a "Contents"
// section, and one topic file per subject in a folder beside it (docs/protocol/). Pure checks over file contents, so a test
// can show them on faulty examples; scripts/test/doc-layout.test.ts runs them on the real files.

/** A split document: its index file and the folder of its topic files, both relative to the repository. */
export interface Split {
  index: string;
  dir: string;
}

/** The documents split so far. */
export const SPLITS: Split[] = [
  { index: "docs/PROTOCOL.md", dir: "docs/protocol" },
  { index: "docs/DESIGN.md", dir: "docs/design" },
];

/** A topic file over this size gets a warning (never a failure): it should be split along its headings. */
export const TOPIC_WARN_BYTES = 40 * 1024;

/** Files already over the size, known and accepted (a single section; splitting it would mean moving paragraphs). */
export const KNOWN_LARGE = new Set(["docs/protocol/api.md"]);

/** Lines of a Markdown text outside fenced code blocks, with their 1-based numbers. */
function proseLines(text: string): { n: number; line: string }[] {
  const out: { n: number; line: string }[] = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (!fenced) out.push({ n: i + 1, line });
  });
  return out;
}

/** GitHub's anchor of a heading's text: lower case, punctuation dropped, spaces as hyphens. */
export function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/ /g, "-");
}

/** The anchors of a Markdown text; a repeated heading gets -1, -2 … as on GitHub. */
export function anchors(text: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const { line } of proseLines(text)) {
    const m = /^#{1,6} +(.*?) *#*$/.exec(line);
    if (!m?.[1]) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** The relative links of a Markdown text (outside code blocks and inline code): target and line. */
export function links(text: string): { target: string; n: number }[] {
  const out: { target: string; n: number }[] = [];
  for (const { n, line } of proseLines(text)) {
    const bare = line.replace(/`[^`]*`/g, "");
    for (const m of bare.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (target && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) out.push({ target, n });
    }
  }
  return out;
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** A path made of `base` and a relative `rel` (`../x.md`, `y/z.md`), without `.` and `..`; null when it leaves the root. */
export function resolvePath(base: string, rel: string): string | null {
  const parts = base ? base.split("/") : [];
  for (const p of rel.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.pop()) return null; } else parts.push(p);
  }
  return parts.join("/");
}

/**
 * Broken relative links and anchors in the Markdown files of `files` (path from the repository root → text). A link to
 * a file that is not Markdown, or not in `files`, is checked with `exists`; an anchor only where its file is in `files`.
 */
export function brokenLinks(files: ReadonlyMap<string, string>, exists: (path: string) => boolean): string[] {
  const problems: string[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (path: string, text: string) => {
    let a = anchorCache.get(path);
    if (!a) anchorCache.set(path, (a = anchors(text)));
    return a;
  };
  for (const [path, text] of files) {
    for (const { target, n } of links(text)) {
      const hash = target.indexOf("#");
      const rawPath = hash < 0 ? target : target.slice(0, hash);
      const frag = hash < 0 ? "" : decodeURIComponent(target.slice(hash + 1));
      const to = rawPath === "" ? path : resolvePath(dirOf(path), decodeURIComponent(rawPath));
      if (to === null) { problems.push(`${path}:${n}: ${target} leaves the repository`); continue; }
      const dest = files.get(to);
      if (dest === undefined) {
        if (!exists(to)) problems.push(`${path}:${n}: ${target} names a file that does not exist (${to})`);
        continue;
      }
      if (frag !== "" && !anchorsOf(to, dest).has(frag.toLowerCase())) problems.push(`${path}:${n}: ${target} has no heading ${frag} in ${to}`);
    }
  }
  return problems;
}

/**
 * The index's "Contents" against the topic files: every topic file is listed there, and only files that exist.
 * `topics` are the file names in the folder (`files.md`), `index` the index's text.
 */
export function contentsProblems(split: Split, index: string, topics: readonly string[]): string[] {
  const problems: string[] = [];
  const lines = proseLines(index);
  const at = lines.findIndex(({ line }) => line === "## Contents");
  if (at < 0) return [`${split.index} has no "## Contents" section`];
  const rest = lines.slice(at + 1);
  const next = rest.findIndex(({ line }) => /^#{1,2} /.test(line));
  const listed = new Set<string>();
  const folder = split.dir.slice(dirOf(split.dir).length + 1);
  for (const { line } of next < 0 ? rest : rest.slice(0, next)) {
    for (const m of line.matchAll(/\]\(([^)#\s]+)/g)) {
      const target = m[1] ?? "";
      if (target.startsWith(`${folder}/`)) listed.add(target.slice(folder.length + 1));
    }
  }
  for (const t of topics) if (!listed.has(t)) problems.push(`${split.index}: Contents does not list ${split.dir}/${t}`);
  for (const l of listed) if (!topics.includes(l)) problems.push(`${split.index}: Contents lists ${split.dir}/${l}, which does not exist`);
  return problems;
}

/** The topic files over the size limit, with their size in KB; a known one says so. */
export function largeTopics(sizes: ReadonlyMap<string, number>): string[] {
  return [...sizes]
    .filter(([, bytes]) => bytes > TOPIC_WARN_BYTES)
    .map(([path, bytes]) => {
      const kb = Math.round(bytes / 1024);
      return KNOWN_LARGE.has(path)
        ? `${path} is ${kb} KB (a known exception: one section)`
        : `${path} is ${kb} KB: split it along its headings, and list the parts in the Contents`;
    });
}
