// The layout of the documents split by topic (docs/doc-split-plan.md): an index file (docs/PROTOCOL.md) with a "Contents"
// section, and one topic file per subject in a folder beside it (docs/protocol/). Pure checks over file contents, so a test
// can show them on faulty examples; scripts/test/doc-layout.test.ts runs them on the real files.
// Besides, the prose check (proseProblems): backticked repository paths and nexus commands in the text must exist.

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

/**
 * The `nexus` commands the CLI's help text names: command → its literal subcommands (`step` → start, progress …), or
 * null where the word after the command is free (an id, a text: `nexus check <step>`, `nexus run <queue>`).
 */
type CliCommands = Map<string, Set<string> | null>;

/** The commands of the CLI's help text (each line `  nexus <command> [<subcommand>|<placeholder>] …`). */
export function helpCommands(help: string): CliCommands {
  const out: CliCommands = new Map();
  // One space before the second word: after more, a line's description begins (`nexus tags      the tags …`).
  for (const m of help.matchAll(/^\s*nexus ([a-z][\w-]*)(?: (\S+))?/gm)) {
    const [, command = "", second] = m;
    if (out.get(command) === null) continue;
    const subs = out.get(command) ?? new Set<string>();
    out.set(command, subs);
    if (second === undefined || /^\[?--/.test(second)) continue;
    const literal = /^\[?([a-z][a-z|-]*)\]?$/.exec(second);
    if (literal?.[1]) for (const s of literal[1].split("|")) subs.add(s);
    else out.set(command, null);
  }
  return out;
}

/** The inline code spans of a Markdown text's prose (outside fenced code blocks), with their lines. */
function codeSpans(text: string): { span: string; n: number }[] {
  const out: { span: string; n: number }[] = [];
  for (const { n, line } of proseLines(text)) for (const m of line.matchAll(/`([^`]+)`/g)) if (m[1]) out.push({ span: m[1].trim(), n });
  return out;
}

/** What the prose check knows of the repository: whether a path exists, its top-level entries, the CLI's commands. */
interface ProseFacts {
  exists: (path: string) => boolean;
  roots: ReadonlySet<string>;
  commands: CliCommands;
}

/**
 * What the prose names on purpose although the repository does not have it, with why: a path (and everything under
 * it), or a command as `nexus <command> <subcommand>`. Keep it short; a stale name is fixed in the text instead.
 */
export const ABSENT_ON_PURPOSE = new Map<string, string>([
  ["docs/ideas", "the user's own notes, kept beside the repository but not in it"],
  ["docs/QUEUE.md", "a file of another project (Honeycomb)"],
  ["docs/protocol/README.md", "the layout the split plan weighed and did not take"],
]);

const onPurpose = (name: string): boolean => [...ABSENT_ON_PURPOSE.keys()].some((k) => name === k || name.startsWith(`${k}/`));

/**
 * Inline code in the prose of `files` that names what does not exist: a repository path (its first part one of
 * `roots`, without placeholders such as `<id>` or `*`) that is not there, or a `nexus <command> [<subcommand>]` the
 * CLI's help does not name; ABSENT_ON_PURPOSE passes. A path's `:line` or `#anchor` is dropped first.
 */
export function proseProblems(files: ReadonlyMap<string, string>, facts: ProseFacts): string[] {
  const problems: string[] = [];
  for (const [path, text] of files) {
    for (const { span, n } of codeSpans(text)) {
      const problem = /^nexus /.test(span) ? commandProblem(span, facts.commands) : pathProblem(span, facts);
      if (problem) problems.push(`${path}:${n}: \`${span}\`${problem}`);
    }
  }
  return problems;
}

/** What is wrong with a `nexus <command> [<subcommand>]` span (the text after the span in a problem), or undefined. */
function commandProblem(span: string, commands: CliCommands): string | undefined {
  const [, command = "", second = ""] = /^nexus ([a-z][\w-]*)(?: +(\S+))?/.exec(span) ?? [];
  if (!command) return undefined;
  const subs = commands.get(command);
  if (subs === undefined) return onPurpose(`nexus ${command}`) ? undefined : `: the CLI has no command nexus ${command}`;
  if (subs === null || subs.size === 0 || !/^[a-z][a-z-]*$/.test(second) || subs.has(second)) return undefined;
  return onPurpose(`nexus ${command} ${second}`) ? undefined : `: nexus ${command} has no subcommand ${second} (it has ${[...subs].join(", ")})`;
}

/** What is wrong with a span that names a repository path (its `:line` or `#anchor` dropped), or undefined. */
function pathProblem(span: string, facts: ProseFacts): string | undefined {
  const p = span.replace(/(:\d+(-\d+)?|#[\w-]*)$/, "");
  if (!/^[\w.@-]+(\/[\w.@-]+)+\/?$/.test(p) || !facts.roots.has(p.slice(0, p.indexOf("/")))) return undefined;
  const at = p.replace(/\/$/, "");
  return facts.exists(at) || onPurpose(at) ? undefined : " names a path that does not exist";
}
