// What is open in the dashboard, kept in the browser history so that Back closes the topmost layer.
//
// Each history entry Nexus writes carries a Nav in its state: the hash (project, and the queue or step whose drawer is
// open), the stack of open layers (bottom first), and its depth: how many entries Nexus pushed above the entry the
// app started from. Opening a layer pushes one entry; closing pops back to the entry before it, so Back and a close
// button do the same thing and no dead entries pile up. Switching within a kind of layer (another step, another
// conversation) replaces the entry. With nothing open, Back leaves the app.
//
// This part is pure (no window, no history) and unit tested; nav.ts applies its steps to the browser.

/** A layer is a kind, optionally with a value: "chat", "settings", "item" (the queue or step drawer), "conversation:<id>". */
export type Layer = string;
/**
 * The phone's tab (below 1024 px; see "The phone" in DESIGN.md). It is not a layer: switching tabs rewrites the entry
 * it is on and adds none, so Back closes sheets and layers, then leaves. Absent until a tab is picked (the Waiting tab).
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
 * rewriting the entry; lower down (another step while the chat is open beside it, on a wide screen) by going back to
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
 * Brings a layer that is open lower down (the chat under the Ideas panel, or the other way round) to the top, with the
 * layers that belong to it (a conversation with its Ideas panel); the layers that lay above it stay open, now below
 * it. Back afterwards closes it and shows the one beneath. One that is closed is opened; one on top stays as it is.
 * When Nexus pushed the entries, that is going back to before it and opening the others and then it again; when it
 * did not (the app started with them open), the entry is rewritten in the new order.
 */
export function raise(cur: Nav, kind: string): Step {
  const i = cur.layers.findIndex((x) => kindOf(x) === kind);
  if (i < 0) return open(cur, kind);
  const mine = cur.layers.slice(i).filter((l) => belongsTo(l, kind));
  const others = cur.layers.slice(i + 1).filter((l) => !belongsTo(l, kind));
  if (!others.length) return { op: "none" };
  const k = cur.layers.length - i;
  if (cur.depth >= k) return { op: "back", steps: k, then: (arrived) => reopen(arrived, [...others, ...mine], cur.hash) };
  return { op: "replace", to: { ...cur, layers: [...cur.layers.slice(0, i), ...others, ...mine] } };
}

/**
 * Closes the layer of a kind and the layers that belong to it (a conversation with the Ideas panel, an image with
 * its step). When Nexus pushed their entries, that is going back; layers above it that do not belong to it (the
 * chat beside a step on a wide screen) are opened again after it. When Nexus did not push them (the app started
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
  return { hash, layers, depth: 0 };
}

export type SidePanel = "chat" | "ideas";

/**
 * The chat and the Ideas panel that are open, bottom first: the one opened last lies on top, on a phone (both over
 * the page) and on a wide screen (both on the right). A conversation counts as the Ideas panel it belongs to.
 */
export function panelOrder(nav: Nav): SidePanel[] {
  const at = (p: SidePanel) => nav.layers.findIndex((l) => (p === "ideas" ? kindOf(l) === "ideas" || kindOf(l) === "conversation" : kindOf(l) === p));
  return (["chat", "ideas"] as const).filter((p) => at(p) >= 0).sort((a, b) => at(a) - at(b));
}

// ---------------------------------------------------------------- the phone

export const TABS: readonly Tab[] = ["chat", "waiting", "queues", "ideas"];

/** The layers the phone shows as tabs instead: the chat, the Ideas panel and the waiting list. */
const TABBED: Record<string, Tab> = { chat: "chat", ideas: "ideas", waiting: "waiting" };

/**
 * What the phone shows for an entry: its tab, and the layers over it. A chat, Ideas or waiting layer (from a link with
 * ?chat, a wide window made narrow, or "Chat about this" on a step) is shown as its tab, the topmost of them winning;
 * a conversation stays a layer, over the Ideas tab. Without either, the Waiting tab.
 */
export function phoneView(nav: Nav): { tab: Tab; layers: Layer[] } {
  const tabbed = nav.layers.filter((l) => kindOf(l) in TABBED || kindOf(l) === "conversation");
  const top = tabbed.at(-1);
  const tab = top === undefined ? nav.tab ?? "waiting" : kindOf(top) === "conversation" ? "ideas" : TABBED[kindOf(top)]!;
  return { tab, layers: nav.layers.filter((l) => !(kindOf(l) in TABBED)) };
}

/**
 * Switches the phone's tab. It adds no entry: what is open over the current tab (a conversation, a sheet) closes
 * first, going back over the entries Nexus pushed for it, and the entry arrived at is rewritten with the new tab.
 * Tapping the tab already shown closes what is open over it (a conversation back to the list).
 */
export function switchTab(cur: Nav, tab: Tab): Step {
  const n = cur.layers.length;
  const rewrite = (at: Nav): Step => ({ op: "replace", to: { ...at, tab, layers: [] } });
  if (n && cur.depth >= n) return { op: "back", steps: n, then: (arrived) => [rewrite(arrived)] };
  if (!n && phoneView(cur).tab === tab) return { op: "none" };
  return rewrite(cur);
}

/**
 * Shows a project's page, in place (switching projects is not a layer, so Back does not walk through them). What is
 * open closes first. On the phone the Waiting tab shows afterwards: the chat does not open by itself.
 */
export function switchProject(cur: Nav, hash: string, phone: boolean): Step {
  const patch: Partial<Nav> = phone ? { tab: "waiting" } : {};
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
 * Opens a conversation on the phone: over the Ideas tab. From elsewhere (a step's sheet, another tab) what is open
 * closes first and the Ideas tab shows; from another conversation, it is switched in place.
 */
export function phoneConversation(cur: Nav, id: string): Step {
  const onIdeas = phoneView(cur).tab === "ideas" && cur.layers.every((l) => kindOf(l) === "conversation");
  const layer = `conversation:${id}`;
  return onIdeas ? open(cur, layer) : andThen(cur, switchTab(cur, "ideas"), (at) => open(at, layer));
}
