// Applies layers.ts to the browser: history entries, Back, Escape, and a React hook to read what is open.
import { useSyncExternalStore } from "react";
import { close, closeThen, closeTop, navOf, open, type Layer, type Nav, type Step } from "./layers.ts";

const write = (n: Nav, how: "push" | "replace") =>
  history[how === "push" ? "pushState" : "replaceState"]({ ...(history.state ?? {}), nexus: n }, "", n.hash || location.pathname + location.search);

let current: Nav = { hash: "", layers: [], depth: 0 };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
let after: ((arrived: Nav) => Step[]) | undefined;

function apply(step: Step): void {
  switch (step.op) {
    case "none": return;
    case "push": case "replace":
      write(step.to, step.op); current = step.to; emit(); return;
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
  emit();
  if (then) for (const s of then(current)) apply(s);
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

/** What is open now; re-renders when it changes. */
export function useNav(): Nav {
  start();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
}

export const nav = {
  /** Opens a panel or a nested layer ("chat", "conversation:<id>"…) on top. */
  open: (layer: Layer) => apply(open(current, layer)),
  /** Closes the layer of this kind and what lies above it. */
  close: (kind: string) => apply(close(current, kind, kind === "item" ? projectHash() : current.hash)),
  /** Opens a queue or step in its drawer; from one already open, it switches in place. */
  item: (project: string, queue: string, step?: string) => apply(open(current, "item", hashOf(project, queue, step))),
  /** Shows a project's page, in place: switching projects is not a layer, so Back does not walk through them. */
  project: (project: string) => apply(current.layers.length
    ? closeThen(current, current.layers[0]!.split(":")[0]!, hashOf(project))
    : { op: "replace", to: { ...current, hash: hashOf(project) } }),
  /** Closes a layer, then opens a queue or step in another project (the waiting list). */
  closeThenItem: (kind: string, project: string, queue?: string, step?: string) =>
    apply(queue ? closeThen(current, kind, hashOf(project, queue, step), "item") : closeThen(current, kind, hashOf(project))),
};
