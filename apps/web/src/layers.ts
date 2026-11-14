// What is open in the dashboard, kept in the browser history so that Back closes the topmost layer.
//
// Each history entry Nexus writes carries a Nav in its state: the hash (project, and the queue or step whose drawer is
// open), the stack of open layers (bottom first), and its depth: how many entries Nexus pushed above the entry the
// app started from. Opening a layer pushes one entry; closing pops back to the entry before it, so Back and a close
// button do the same thing and no dead entries pile up. Switching within a kind of layer (another step, another
// conversation) replaces the entry. With nothing open, Back leaves the app.
//
// This part is pure (no window, no history) and unit tested; nav.ts applies its steps to the browser.
import { fileLayer } from "./fileview.ts";

/**
 * A layer is a kind, optionally with a value: "settings", "item" (the queue or step drawer), "conversation:<id>",
 * "file:<line>:<path>" (the file viewer, fileview.ts), "commit:<hash>" (a commit's details).
 */
export type Layer = string;
/**
 * The view: the phone's tab (below 1024 px; "The phone" in DESIGN.md), or what a desktop's middle column shows (the
 * chat, Ideas or the project's queues; "Chat-first on a desktop"). It is not a layer: switching rewrites the entry it
 * is on and adds none, so Back closes sheets and layers, then leaves. Absent until one is picked (the layout's first).
 */
export type Tab = "chat" | "waiting" | "queues" | "ideas";
export interface Nav { hash: string; layers: Layer[]; depth: number; tab?: Tab }

export type Step =
  | { op: "none" }
  | { op: "push" | "replace"; to: Nav }
  /** Go back `steps` entries; then, if given, apply what `then` makes of the entry arrived at. */
  | { op: "back"; steps: number; then?: (arrived: Nav) => Step[] }
  /** One after the other. */
  | { op: "seq"; steps: Step[] };

export const kindOf = (layer: Layer) => layer.split(":")[0]!;
const valueOf = (layer: Layer) => layer.includes(":") ? layer.slice(layer.indexOf(":") + 1) : undefined;

/** The value of the open layer of a kind ("conversation" → its id), or undefined when none is open. */
export function layerValue(nav: Nav, kind: string): string | undefined {
  const l = nav.layers.find((x) => kindOf(x) === kind);
  return l === undefined ? undefined : valueOf(l) ?? "";
}
export const isOpen = (nav: Nav, kind: string) => nav.layers.some((x) => kindOf(x) === kind);

/** A hash with a queue in it has the queue or step drawer open. */
export const hasItem = (hash: string) => hash.replace(/^#\/?/, "").split("/").filter(Boolean).length > 1;

/** Layers that belong to another and close with it: a conversation in the Ideas panel, an image of a step. */
const PARENT: Record<string, string> = { conversation: "ideas", viewer: "item" };
const belongsTo = (layer: Layer, kind: string) => kindOf(layer) === kind || PARENT[kindOf(layer)] === kind;

/** Pushes layers one by one from `at` (the drawer at `hash`, the others where they stand), as steps. */
function reopen(at: Nav, layers: Layer[], hash: string): Step[] {
  const steps: Step[] = [];
  for (const l of layers) {
    const s = open(at, l, kindOf(l) === "item" ? hash : at.hash);
    if (s.op === "push" || s.op === "replace") { steps.push(s); at = s.to; }
  }
  return steps;
}

/**
 * Opens a layer on top (at a new hash, for the drawer). The same kind already open is switched in place: on top by
 * rewriting the entry; lower down (another step while a conversation is open over it, on a desktop) by going back to
 * its entry and opening it and what lay above it again, so Back keeps closing the topmost.
 */
export function open(cur: Nav, layer: Layer, hash = cur.hash): Step {
  const top = cur.layers.at(-1);
  if (top === layer && hash === cur.hash) return { op: "none" };
  if (top !== undefined && kindOf(top) === kindOf(layer)) return { op: "replace", to: { ...cur, hash, layers: [...cur.layers.slice(0, -1), layer] } };
  const i = cur.layers.findIndex((x) => kindOf(x) === kindOf(layer));
  if (i >= 0) {
    const above = cur.layers.slice(i + 1);
    const k = cur.layers.length - i;
    if (cur.depth >= k) return { op: "back", steps: k, then: (arrived) => reopen(arrived, [layer, ...above], hash) };
    return { op: "replace", to: { ...cur, hash, layers: cur.layers.map((x, j) => (j === i ? layer : x)) } };
  }
  return { op: "push", to: { ...cur, hash, layers: [...cur.layers, layer], depth: cur.depth + 1 } };
}

/**
 * Closes the layer of a kind and the layers that belong to it (a conversation with the Ideas panel, an image with
 * its step). When Nexus pushed their entries, that is going back; layers above it that do not belong to it (a
 * conversation opened beside the step on a desktop) are opened again after it. When Nexus did not push them (the app started
 * with them open), the current entry is rewritten without them (at `closedHash` when the drawer closes).
 */
export function close(cur: Nav, kind: string, closedHash = cur.hash): Step {
  const i = cur.layers.findIndex((x) => kindOf(x) === kind);
  if (i < 0) return { op: "none" };
  const k = cur.layers.length - i;
  const keep = cur.layers.slice(i + 1).filter((l) => !belongsTo(l, kind));
  if (cur.depth >= k) return keep.length ? { op: "back", steps: k, then: (arrived) => reopen(arrived, keep, cur.hash) } : { op: "back", steps: k };
  return { op: "replace", to: { ...cur, hash: closedHash, layers: [...cur.layers.slice(0, i), ...keep], depth: cur.depth } };
}

/** Closes the topmost layer (Escape). */
export function closeTop(cur: Nav, closedHash: string): Step {
  const top = cur.layers.at(-1);
  return top === undefined ? { op: "none" } : close(cur, kindOf(top), kindOf(top) === "item" ? closedHash : cur.hash);
}

/**
 * Closes a layer and then opens something else from where that leaves the user: another project from the picker
 * (`layer` undefined: only the hash changes, in place), or an item of another project from the waiting list (the
 * project first, in place, then the item on top, so Back closes the item and stays in that project).
 */
export function closeThen(cur: Nav, kind: string, hash: string, layer?: Layer, patch: Partial<Nav> = {}): Step {
  const after = (arrived: Nav): Step[] => {
    const base = hash.replace(/^(#\/[^/]+).*$/, "$1");
    const steps: Step[] = [];
    const at: Nav = { ...arrived, ...patch, hash: layer ? base : hash };
    if (!hasItem(at.hash)) at.layers = at.layers.filter((l) => kindOf(l) !== "item");
    if (at.hash !== arrived.hash || at.tab !== arrived.tab) steps.push({ op: "replace", to: at });
    if (layer) steps.push(open(at, layer, hash));
    return steps;
  };
  const closing = close(cur, kind);
  if (closing.op === "back") return { ...closing, then: after };
  const arrived = closing.op === "replace" ? closing.to : cur;
  return { op: "seq", steps: [...(closing.op === "none" ? [] : [closing]), ...after(arrived)] };
}

/**
 * The Nav of a history entry. Entries Nexus wrote carry it; others (the first page load, a hash typed by hand) get
 * one from the hash and the query (?chat, ?settings… open a layer at load), with depth 0.
 */
export function navOf(state: unknown, hash: string, query: string): Nav {
  const s = (state as { nexus?: Partial<Nav> } | null)?.nexus;
  if (s && Array.isArray(s.layers) && typeof s.depth === "number") {
    // The hash is the truth for the drawer: a hash edited by hand on a Nexus entry still opens or closes it.
    const layers = s.layers.filter((l) => typeof l === "string" && (kindOf(l) !== "item" || hasItem(hash)));
    if (hasItem(hash) && !layers.some((l) => kindOf(l) === "item")) layers.unshift("item");
    return { hash, layers, depth: s.depth, ...(TABS.includes(s.tab as Tab) ? { tab: s.tab } : {}) };
  }
  const q = new URLSearchParams(query);
  const layers: Layer[] = hasItem(hash) ? ["item"] : [];
  for (const k of ["ideas", "chat", "settings", "remote", "waiting", "projects"]) if (q.has(k)) layers.push(k);
  // ?file=<path>&line=<n> opens a file in the viewer (components/FileView.tsx) over the rest.
  const file = q.get("file");
  if (file) layers.push(fileLayer(file, Number(q.get("line")) || undefined));
  // ?commit=<hash> opens a commit's details (components/Commit.tsx).
  const commit = q.get("commit");
  if (commit) layers.push(`commit:${commit}`);
  return { hash, layers, depth: 0 };
}

// ---------------------------------------------------------------- the views: the phone's tabs, a desktop's middle

/** Which layout reads an entry: the phone (below 1024 px) or a desktop (from 1024 px). */
export type Layout = "phone" | "desk";

export const TABS: readonly Tab[] = ["chat", "waiting", "queues", "ideas"];

/**
 * The layers a layout shows as a view instead: on the phone the chat, the Ideas panel and the waiting list are tabs;
 * on a desktop the chat and Ideas are the middle column (the waiting list stays a drawer there).
 */
const TABBED: Record<Layout, Record<string, Tab>> = {
  phone: { chat: "chat", ideas: "ideas", waiting: "waiting" },
  desk: { chat: "chat", ideas: "ideas" },
};
/** The views a layout has, the first shown when none is picked (or the picked one is not the layout's). */
const VIEWS: Record<Layout, readonly Tab[]> = { phone: ["waiting", "chat", "queues", "ideas"], desk: ["chat", "ideas", "queues"] };

/** The view a layer stands for in a layout ("chat" → the chat), or undefined when it stays a layer. */
export const viewFor = (layout: Layout, layer: Layer): Tab | undefined => TABBED[layout][layer];

/**
 * What a layout shows for an entry: its view (the phone's tab, a desktop's middle column), and the layers over it. A
 * chat, Ideas or (on the phone) waiting layer, from a link with ?chat, a window resized across 1024 px or older code,
 * is shown as its view, the topmost of them winning; a conversation stays a layer, over the Ideas view. Without
 * either, the entry's tab, or the layout's first view: Waiting on the phone, the chat on a desktop.
 */
export function viewOf(nav: Nav, layout: Layout): { tab: Tab; layers: Layer[] } {
  const tabbed = TABBED[layout];
  const top = nav.layers.filter((l) => kindOf(l) in tabbed || kindOf(l) === "conversation").at(-1);
  const own = nav.tab !== undefined && VIEWS[layout].includes(nav.tab) ? nav.tab : VIEWS[layout][0]!;
  const tab = top === undefined ? own : kindOf(top) === "conversation" ? "ideas" : tabbed[kindOf(top)]!;
  return { tab, layers: nav.layers.filter((l) => !(kindOf(l) in tabbed)) };
}
export const phoneView = (nav: Nav) => viewOf(nav, "phone");

/**
 * Switches the view. It adds no entry: on the phone what is open over the current tab (a conversation, a sheet)
 * closes first, going back over the entries Nexus pushed for it, and the entry arrived at is rewritten with the new
 * tab; tapping the tab already shown closes what is open over it (a conversation back to the list). On a desktop what
 * lies beside the middle column (a queue or step, its image) stays open: Nexus goes back to the entry below it,
 * rewrites that with the new view and opens it again, so Back afterwards still closes it and keeps the view; only a
 * conversation, which belongs to the Ideas view, closes.
 */
export function switchTab(cur: Nav, tab: Tab, layout: Layout = "phone"): Step {
  const n = cur.layers.length;
  if (layout === "phone") {
    const rewrite = (at: Nav): Step => ({ op: "replace", to: { ...at, tab, layers: [] } });
    if (n && cur.depth >= n) return { op: "back", steps: n, then: (arrived) => [rewrite(arrived)] };
    if (!n && phoneView(cur).tab === tab) return { op: "none" };
    return rewrite(cur);
  }
  const keep = cur.layers.filter((l) => !(kindOf(l) in TABBED.desk) && kindOf(l) !== "conversation");
  if (keep.length === n && viewOf(cur, "desk").tab === tab) return { op: "none" };
  if (n && cur.depth >= n) {
    return {
      op: "back", steps: n,
      then: (arrived) => { const at: Nav = { ...arrived, tab, layers: [] }; return [{ op: "replace", to: at }, ...reopen(at, keep, cur.hash)]; },
    };
  }
  return { op: "replace", to: { ...cur, tab, layers: keep } };
}

/**
 * Shows a project, in place (switching projects is not a layer, so Back does not walk through them). What is open
 * closes first. Then the phone shows its Waiting tab (the chat does not open by itself there), a desktop the
 * project's orchestrator chat.
 */
export function switchProject(cur: Nav, hash: string, layout: Layout): Step {
  const patch: Partial<Nav> = { tab: layout === "phone" ? "waiting" : "chat" };
  return cur.layers.length
    ? closeThen(cur, kindOf(cur.layers[0]!), hash, undefined, patch)
    : { op: "replace", to: { ...cur, ...patch, hash } };
}

/** Where a list of steps leaves an entry: the last one they write. */
function endOf(at: Nav, steps: Step[]): Nav {
  for (const s of steps) {
    if (s.op === "push" || s.op === "replace") at = s.to;
    else if (s.op === "seq") at = endOf(at, s.steps);
  }
  return at;
}

/** One step, then another made from where the first leaves the user (also after a Back, once it has arrived). */
export function andThen(cur: Nav, first: Step, next: (at: Nav) => Step): Step {
  if (first.op === "back") {
    return { ...first, then: (arrived) => { const done = first.then?.(arrived) ?? []; return [...done, next(endOf(arrived, done))]; } };
  }
  return { op: "seq", steps: [first, next(endOf(cur, [first]))] };
}

/**
 * Opens a conversation over the Ideas view. From another view the view switches first: on the phone what is open
 * (a step's sheet, from "Chat about this") closes; on a desktop a step stays open beside it. From another
 * conversation, it is switched in place. Back returns to the list.
 */
export function openConversation(cur: Nav, id: string, layout: Layout = "phone"): Step {
  const layer = `conversation:${id}`;
  const onIdeas = viewOf(cur, layout).tab === "ideas" && (layout === "desk" || cur.layers.every((l) => kindOf(l) === "conversation"));
  return onIdeas ? open(cur, layer) : andThen(cur, switchTab(cur, "ideas", layout), (at) => open(at, layer));
}
