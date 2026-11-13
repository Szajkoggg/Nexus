// Refs in a chat (UX proposals, shared by all mockups): the ids of the project's queues and steps in a message
// ("UX2", "W4c", "SF", "W / W4c") become links that open the item. Only the ids of this project's queues and steps
// count, never any word that looks like one. Pure and unit tested; components/Refs.tsx draws the links.

/** Where a ref leads: a queue, or a step of it. */
export interface RefTarget { queue: string; step?: string }
/** A piece of text: plain, or a ref with the words it was written as. */
export type Segment = string | (RefTarget & { text: string });

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

/** Splits a text into plain pieces and refs, in order; the pieces joined give the text back. */
export function splitRefs(text: string, index: RefIndex): Segment[] {
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
