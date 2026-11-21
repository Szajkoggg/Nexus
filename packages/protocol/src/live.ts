// The live stream's changes (queue SD; docs/design/live.md, docs/protocol/live.md): a project's state as parts, each
// serialized once, the delta between two of them, and applying a delta to a held state. Free of Node so that the
// dashboard applies with the same code the server diffs with.
import type { ProjectState } from "./state.ts";
import type { ProjectSummary } from "./api.ts";

/** The parts of the state replaced whole when they differ. */
const WHOLE_PARTS = ["project", "away", "tags", "metrics", "attention", "warnings", "generated_at"] as const;
export type WholePart = (typeof WHOLE_PARTS)[number];
/** The lists sent member by member, each with the key of its members. */
const KEYED_PARTS = { queues: "id", sessions: "id", questions: "qid", recurring: "id" } as const;
export type KeyedPart = keyof typeof KEYED_PARTS;
const KEYED = Object.keys(KEYED_PARTS) as KeyedPart[];

type Member<K extends KeyedPart> = ProjectState[K][number];

/** A state message's change: the parts that differ from the state of the project's previous state message. */
export interface StateDelta {
  set?: Partial<Pick<ProjectState, WholePart>>;
  upsert?: { [K in KeyedPart]?: Member<K>[] };
  remove?: { [K in KeyedPart]?: string[] };
  order?: { [K in KeyedPart]?: string[] };
}

/** A state held as texts: each whole part's JSON, and each keyed list's keys in order with each member's JSON. */
export interface StateTexts {
  whole: Record<WholePart, string>;
  keyed: Record<KeyedPart, { order: string[]; texts: Map<string, string> }>;
  /** The length of the whole state's JSON (the full read): what a delta is weighed against. */
  size: number;
}

/** The state's texts; undefined when a keyed list repeats a key (it is then sent whole, as a reload). */
export function stateTexts(s: ProjectState): StateTexts | undefined {
  const whole = {} as Record<WholePart, string>;
  let size = 2;
  for (const p of WHOLE_PARTS) { whole[p] = JSON.stringify(s[p] ?? null); size += p.length + 4 + whole[p].length; }
  const keyed = {} as StateTexts["keyed"];
  for (const p of KEYED) {
    const key = KEYED_PARTS[p];
    const order: string[] = [];
    const texts = new Map<string, string>();
    for (const m of s[p] as unknown as readonly Record<string, unknown>[]) {
      const k = String(m[key]);
      if (texts.has(k)) return undefined;
      const t = JSON.stringify(m);
      order.push(k); texts.set(k, t); size += t.length + 1;
    }
    keyed[p] = { order, texts };
    size += p.length + 5;
  }
  return { whole, keyed, size };
}

/** The full state's JSON from its texts (the full read, without serializing again). */
export function stateJson(t: StateTexts): string {
  const parts = WHOLE_PARTS.map((p) => `${JSON.stringify(p)}:${t.whole[p]}`);
  for (const p of KEYED) parts.push(`${JSON.stringify(p)}:[${t.keyed[p].order.map((k) => t.keyed[p].texts.get(k)).join(",")}]`);
  return `{${parts.join(",")}}`;
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The delta from `prev` to `next` as the JSON of a `StateDelta` (its fields only, without braces: the message adds its
 * own), and the keyed members it names; undefined when nothing differs.
 */
export function deltaJson(prev: StateTexts, next: StateTexts): { json: string; touched: { [K in KeyedPart]: string[] }; set: WholePart[] } | undefined {
  const set: string[] = [], upsert: string[] = [], remove: string[] = [], order: string[] = [];
  const touched = { queues: [], sessions: [], questions: [], recurring: [] } as { [K in KeyedPart]: string[] };
  const setParts: WholePart[] = [];
  for (const p of WHOLE_PARTS) if (prev.whole[p] !== next.whole[p]) { set.push(`${JSON.stringify(p)}:${next.whole[p]}`); setParts.push(p); }
  for (const p of KEYED) {
    const a = prev.keyed[p], b = next.keyed[p];
    const changed = b.order.filter((k) => a.texts.get(k) !== b.texts.get(k));
    const gone = a.order.filter((k) => !b.texts.has(k));
    if (changed.length) upsert.push(`${JSON.stringify(p)}:[${changed.map((k) => b.texts.get(k)).join(",")}]`);
    if (gone.length) remove.push(`${JSON.stringify(p)}:${JSON.stringify(gone)}`);
    if (!sameOrder(a.order, b.order)) order.push(`${JSON.stringify(p)}:${JSON.stringify(b.order)}`);
    touched[p] = [...changed, ...gone];
  }
  if (!set.length && !upsert.length && !remove.length && !order.length) return undefined;
  const fields: string[] = [];
  if (set.length) fields.push(`"set":{${set.join(",")}}`);
  if (upsert.length) fields.push(`"upsert":{${upsert.join(",")}}`);
  if (remove.length) fields.push(`"remove":{${remove.join(",")}}`);
  if (order.length) fields.push(`"order":{${order.join(",")}}`);
  return { json: fields.join(","), touched, set: setParts };
}

/** The delta from `a` to `b` (the server's diff, as an object: for tests and for callers without texts). */
export function diffState(a: ProjectState, b: ProjectState): StateDelta | undefined {
  const ta = stateTexts(a), tb = stateTexts(b);
  if (!ta || !tb) throw new Error("a keyed list repeats a key");
  const d = deltaJson(ta, tb);
  return d && JSON.parse(`{${d.json}}`) as StateDelta;
}

/**
 * The held state with the delta applied: a new object (the held one is not changed); undefined when the delta cannot
 * apply to it (an order naming a member neither held nor sent): the view then reads in full.
 */
export function applyState(held: ProjectState, d: StateDelta): ProjectState | undefined {
  const out = { ...held } as Record<string, unknown>;
  for (const [p, v] of Object.entries(d.set ?? {})) out[p] = v;
  for (const p of KEYED) {
    const up = d.upsert?.[p] as Record<string, unknown>[] | undefined, gone = d.remove?.[p], order = d.order?.[p];
    if (!up && !gone && !order) continue;
    const key = KEYED_PARTS[p];
    const byKey = new Map((held[p] as unknown as readonly Record<string, unknown>[]).map((m) => [String(m[key]), m]));
    const keys = [...byKey.keys()];
    for (const k of gone ?? []) byKey.delete(k);
    for (const m of up ?? []) { const k = String(m[key]); if (!byKey.has(k)) keys.push(k); byKey.set(k, m); }
    const list: unknown[] = [];
    for (const k of order ?? keys) {
      const m = byKey.get(k);
      if (m) list.push(m);
      else if (order) return undefined;
    }
    out[p] = list;
  }
  return out as unknown as ProjectState;
}

// ---------------------------------------------------------------- the messages

/** A chat agent's head: what its views show beside the chat (docs/protocol/live.md). */
interface SessionHead { [field: string]: unknown }

/** Every message about a project carries it and its sequence number. */
interface ProjectMessage { project: string; seq: number }
export type LogKind = "activity" | "chat" | "refusals" | "pins";

export type LiveMessage =
  | { type: "hello"; epoch: string; projects: Record<string, number> }
  | (ProjectMessage & { type: "state"; reload?: true; summary?: ProjectSummary } & StateDelta)
  | (ProjectMessage & { type: "log"; session: string; log: LogKind; entries?: unknown[]; pins?: unknown[]; reload?: true })
  | (ProjectMessage & { type: "session"; session: string; orchestrator?: true; head: SessionHead; conversation?: Record<string, unknown> })
  | { type: "projects" }
  | { type: "server" };

/** The response header naming where a reply stands: `<epoch> <seq>` (the project list: `<epoch>`). */
export const SEQ_HEADER = "Nexus-Seq";

/** Where a reply stands, from its `Nexus-Seq` header (each part undefined when the header leaves it out). */
export function readPosition(header: string | null): { epoch: string | undefined; seq: number | undefined } {
  const [epoch, seq] = (header ?? "").split(" ");
  return { epoch: epoch || undefined, seq: seq ? Number(seq) : undefined };
}

/** The conversation list's order: the archived last, then the latest message first (the server and the dashboard). */
export const byConversationOrder = (a: { archived?: boolean; last_at: string }, b: { archived?: boolean; last_at: string }): number =>
  Number(!!a.archived) - Number(!!b.archived) || b.last_at.localeCompare(a.last_at);
