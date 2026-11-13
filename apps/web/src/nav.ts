// Applies layers.ts to the browser: history entries, Back, Escape, and a React hook to read what is open.
import { useSyncExternalStore } from "react";
import { close, closeThen, closeTop, navOf, open, openConversation, switchProject, switchTab, viewFor, type Layer, type Layout, type Nav, type Step, type Tab } from "./layers.ts";
import { PHONE } from "./phone.ts";

const write = (n: Nav, how: "push" | "replace") =>
  history[how === "push" ? "pushState" : "replaceState"]({ ...(history.state ?? {}), nexus: n }, "", n.hash || location.pathname + location.search);

let current: Nav = { hash: "", layers: [], depth: 0 };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
let after: ((arrived: Nav) => Step[]) | undefined;
/** While the steps after a Back run, React hears only of where they end. */
let quiet = false;

function apply(step: Step): void {
  switch (step.op) {
    case "none": return;
    case "push": case "replace":
      write(step.to, step.op); current = step.to; if (!quiet) emit(); return;
    case "seq":
      for (const s of step.steps) apply(s);
      return;
    case "back":
      after = step.then;
      history.go(-step.steps); // popstate brings the entry arrived at
      return;
  }
}

/** Reads the entry the browser is on; an entry Nexus did not write gets its Nav written into it. */
function sync(): void {
  current = navOf(history.state, location.hash, location.search);
  if (!(history.state as { nexus?: unknown } | null)?.nexus) write(current, "replace");
  const then = after;
  after = undefined;
  if (then) { quiet = true; try { for (const s of then(current)) apply(s); } finally { quiet = false; } }
  emit();
}

let started = false;
function start(): void {
  if (started) return;
  started = true;
  sync();
  // A Back (or Forward) through Nexus's entries, and a hash changed by hand, both land here.
  window.addEventListener("popstate", sync);
  window.addEventListener("hashchange", () => { if (location.hash !== current.hash) sync(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && current.layers.length) { e.preventDefault(); apply(closeTop(current, projectHash())); }
  });
}

/** The hash of the current project's page, without a queue or step. */
const projectHash = () => current.hash.replace(/^(#\/[^/]+).*$/, "$1");
const hashOf = (...parts: (string | undefined)[]) => "#/" + parts.filter((x): x is string => !!x).map(encodeURIComponent).join("/");
/**
 * The layout: the phone below 1024 px (the chat, Ideas and the waiting list are tabs there), a desktop from 1024 px
 * (the chat and Ideas are its middle column). Either way they are views, not layers.
 */
const layout = (): Layout => typeof matchMedia !== "undefined" && matchMedia(PHONE).matches ? "phone" : "desk";

/** What is open now; re-renders when it changes. */
export function useNav(): Nav {
  start();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
}

export const nav = {
  /**
   * Opens a layer ("settings", "conversation:<id>"…) on top. The chat and Ideas (on the phone also the waiting list)
   * are views: opening one shows it (`switchTab`).
   */
  open: (layer: Layer) => {
    const l = layout();
    const view = viewFor(l, layer);
    apply(view ? switchTab(current, view, l) : open(current, layer));
  },
  /** Opens a conversation over the Ideas view, showing that view first. */
  conversation: (id: string) => apply(openConversation(current, id, layout())),
  /** Shows a view: the phone's tabs (Orchestrator, Waiting, Queues, Ideas), a desktop's middle column. No history entry. */
  tab: (tab: Tab) => apply(switchTab(current, tab, layout())),
  /** Closes the layer of this kind and what lies above it. */
  close: (kind: string) => apply(close(current, kind, kind === "item" ? projectHash() : current.hash)),
  /** Opens a queue or step in its drawer; from one already open, it switches in place. */
  item: (project: string, queue: string, step?: string) => apply(open(current, "item", hashOf(project, queue, step))),
  /** Shows a project, in place: switching projects is not a layer, so Back does not walk through them. */
  project: (project: string) => apply(switchProject(current, hashOf(project), layout())),
  /** Closes a layer, then opens a queue or step in another project (the waiting list). */
  closeThenItem: (kind: string, project: string, queue?: string, step?: string) =>
    apply(queue ? closeThen(current, kind, hashOf(project, queue, step), "item") : closeThen(current, kind, hashOf(project))),
};
