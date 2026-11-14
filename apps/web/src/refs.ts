// Refs in a chat (UX proposals, shared by all mockups): the ids of the project's queues and steps in a message
// ("UX2", "W4c", "SF", "W / W4c") become links that open the item. Only the ids of this project's queues and steps
// count, never any word that looks like one. File paths with a line ("apps/server/src/engine.ts:138",
// "C:\Code\x.ts:12:5") and commit hashes ("13118f1") become links too (CH3): they are not checked here but when
// clicked (the file viewer and the commit's details say "not found"), so only their shape counts, kept strict enough
// that plain words, numbers, times, host:port pairs and URLs stay text. Pure and unit tested; components/Refs.tsx
// draws the links.

/** Where a ref leads: a queue, or a step of it. */
export interface RefTarget { queue: string; step?: string }
/** A file at a line (a column, when written, is dropped: the viewer shows lines). */
export interface FileRef { kind: "file"; path: string; line: number }
export interface CommitRef { kind: "commit"; hash: string }
export type Ref = (RefTarget & { kind?: undefined }) | FileRef | CommitRef;
/** A piece of text: plain, or a ref with the words it was written as. */
export type Segment = string | (Ref & { text: string });

export interface RefIndex {
  queues: ReadonlySet<string>;
  /** A step id and the queues that have a step with it (step ids are unique within a queue, not always across them). */
  steps: ReadonlyMap<string, readonly string[]>;
  /** Each queue's steps, for "Q/S". */
  of: ReadonlyMap<string, ReadonlySet<string>>;
  pattern: RegExp | undefined;
}

/**
 * One-letter ids that are also words at the start of a sentence (English "A", "I"; Hungarian "A", "O"): bare, they stay
 * text; written with a step ("A/A1") they are refs.
 */
const WORDS = new Set(["A", "I", "O"]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alt = (ids: Iterable<string>) => [...ids].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(escape).join("|");

export function refIndex(queues: readonly { id: string; steps: readonly { id: string }[] }[]): RefIndex {
  const steps = new Map<string, string[]>();
  const of = new Map<string, Set<string>>();
  for (const q of queues) {
    of.set(q.id, new Set(q.steps.map((s) => s.id)));
    for (const s of q.steps) steps.set(s.id, [...(steps.get(s.id) ?? []), q.id]);
  }
  const all = new Set([...of.keys(), ...steps.keys()]);
  // A ref stands alone: no letter, digit or underscore around it, and not part of a path or a file name ("drafts/SC.yaml").
  const before = "(?<![\\p{L}\\p{N}_/\\\\.\\-])";
  const after = "(?![\\p{L}\\p{N}_]|[/\\\\.][\\p{L}\\p{N}_])";
  const pattern = all.size
    ? new RegExp(`${before}(?:(?<q>${alt(of.keys())})\\s?/\\s?(?<s>${alt(steps.keys())})|(?<id>${alt(all)}))${after}`, "gu")
    : undefined;
  return { queues: new Set(of.keys()), steps, of, pattern };
}

/** What a bare id stands for: a queue, or a step only one queue has. */
function resolve(id: string, index: RefIndex): RefTarget | undefined {
  if (WORDS.has(id)) return undefined;
  if (index.queues.has(id)) return { queue: id };
  const qs = index.steps.get(id);
  return qs?.length === 1 ? { queue: qs[0]!, step: id } : undefined;
}

// ---------------------------------------------------------------- files and commits

/** Extensions a bare file name (no folder) must have to count: "README.md:5" is a file, "example.com:8080" is not. */
const FILE_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonl", "yaml", "yml", "md", "markdown", "txt", "log",
  "csv", "css", "scss", "less", "html", "htm", "xml", "svg", "sh", "bash", "ps1", "psm1", "bat", "cmd", "vbs", "py", "rb",
  "go", "rs", "java", "kt", "cs", "c", "h", "cpp", "hpp", "cc", "swift", "php", "sql", "toml", "ini", "diff", "patch",
  "lua", "r", "vue", "svelte", "lock", "env", "cfg", "conf",
]);
const WORD = String.raw`[\p{L}\p{N}_]`;
/**
 * A path ending in a file name with an extension, then ":line", optionally ":column" or "-line". It may start with a
 * drive ("C:\", "C:/"), "/", "./", "../" or "~/". It stands alone: not inside a word, a URL or a longer path, and a
 * word may follow only after a hyphen (Hungarian suffixes: "engine.ts:138-ban").
 */
const FILE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_/\\.:@#~+-])` +
  String.raw`(?<path>(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|/)?(?:[\p{L}\p{N}_.@+-]+[\\/])*[\p{L}\p{N}_@+-][\p{L}\p{N}_.@+-]*\.(?<ext>[A-Za-z][A-Za-z0-9]{0,9}))` +
  String.raw`:(?<line>[1-9]\d{0,6})(?::\d{1,5}|-\d{1,7})?` +
  String.raw`(?!${WORD}|[/\\:.]${WORD})`,
  "gu");
/**
 * 7 to 40 lowercase hex digits with at least one digit and one letter ("defaced" and "1234567" are not hashes), not
 * inside a word, a path, a colour (#…), an id with a hyphen or a UUID.
 */
const COMMIT = new RegExp(String.raw`(?<![\p{L}\p{N}_/\\.:@#+-])(?<hash>[0-9a-f]{7,40})(?!${WORD}|[/\\:.]${WORD}|-[0-9a-f]{4}-)`, "gu");
/** URLs and bare web addresses: nothing inside them is a file or a commit. */
const URL_LIKE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s<>()]*/giu;

interface Found { start: number; end: number; ref: FileRef | CommitRef }

/** The files and commits in a text, in order, none overlapping and none inside a URL. */
export function findFileRefs(text: string): Found[] {
  const urls = [...text.matchAll(URL_LIKE)].map((m) => [m.index, m.index + m[0].length] as const);
  const free = (a: number, b: number, taken: readonly Found[]) =>
    !urls.some(([x, y]) => a < y && b > x) && !taken.some((f) => a < f.end && b > f.start);
  const files: Found[] = [];
  for (const m of text.matchAll(FILE)) {
    const { path, ext, line } = m.groups as { path: string; ext: string; line: string };
    const start = m.index, end = start + m[0].length;
    if (!/[\\/]/.test(path) && !FILE_EXTS.has(ext.toLowerCase())) continue;
    if (free(start, end, files)) files.push({ start, end, ref: { kind: "file", path, line: Number(line) } });
  }
  const out = [...files];
  for (const m of text.matchAll(COMMIT)) {
    const hash = m.groups!.hash!;
    const start = m.index, end = start + m[0].length;
    if (!/[0-9]/.test(hash) || !/[a-f]/.test(hash)) continue;
    if (free(start, end, files)) out.push({ start, end, ref: { kind: "commit", hash } });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The file or commit a whole text is (an inline code span such as `src/x.ts:12`), or undefined. */
export function wholeRef(text: string): FileRef | CommitRef | undefined {
  const t = text.trim();
  const [f, ...rest] = findFileRefs(t);
  return f && !rest.length && f.start === 0 && f.end === t.length ? f.ref : undefined;
}

/**
 * Splits a text into plain pieces and refs, in order; the pieces joined give the text back. Files and commits first,
 * then the queue and step ids in what lies between them.
 */
export function splitRefs(text: string, index: RefIndex): Segment[] {
  const out: Segment[] = [];
  const push = (s: Segment) => {
    if (typeof s !== "string") { out.push(s); return; }
    if (!s) return;
    const prev = out.at(-1);
    if (typeof prev === "string") out[out.length - 1] = prev + s; else out.push(s);
  };
  let last = 0;
  for (const f of findFileRefs(text)) {
    for (const x of splitIds(text.slice(last, f.start), index)) push(x);
    push({ ...f.ref, text: text.slice(f.start, f.end) });
    last = f.end;
  }
  for (const x of splitIds(text.slice(last), index)) push(x);
  return out;
}

/** The queue and step ids in a text. */
function splitIds(text: string, index: RefIndex): Segment[] {
  const out: Segment[] = [];
  const re = index.pattern;
  if (!re) return text ? [text] : [];
  let last = 0;
  const push = (s: string) => { if (!s) return; const prev = out.at(-1); if (typeof prev === "string") out[out.length - 1] = prev + s; else out.push(s); };
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const { q, s, id } = m.groups as { q?: string; s?: string; id?: string };
    let target: RefTarget | undefined;
    let matched = m[0];
    if (q && s && index.of.get(q)?.has(s)) target = { queue: q, step: s };
    else if (q) {
      // "Q/S" where S is not Q's step: only Q is a ref, and the scan goes on after it.
      matched = q;
      target = resolve(q, index);
      re.lastIndex = m.index + q.length;
    } else if (id) target = resolve(id, index);
    push(text.slice(last, m.index));
    if (target) out.push({ ...target, text: matched });
    else push(matched);
    last = m.index + matched.length;
  }
  push(text.slice(last));
  return out;
}
