// What waits for the user across all projects, as one list. Pure and free of Node: the dashboard imports this module
// directly (`@nexus/protocol/attention`), so it imports nothing at run time.
import type { AttentionItem } from "./state.ts";

export interface ProjectAttention { id: string; name: string; attention: AttentionItem[] }
export interface WaitingItem extends AttentionItem { project: string; project_name: string }

/**
 * Every project's items in one list, newest first. Items without a time go last; equal times keep the projects'
 * order and each project's own order.
 */
export function mergeAttention(projects: readonly ProjectAttention[]): WaitingItem[] {
  const all = projects.flatMap((p) => p.attention.map((a) => ({ ...a, project: p.id, project_name: p.name })));
  // Array.prototype.sort is stable, so ties keep the order above.
  return all.sort((a, b) => {
    if (!a.at || !b.at) return a.at ? -1 : b.at ? 1 : 0;
    return Date.parse(b.at) - Date.parse(a.at);
  });
}

/**
 * Where a stopped queue's stop is, as a phrase to follow "stopped": " at step W4b" while that step holds it; once the
 * step is finished (the orchestrator skipped it), the stop is the queue's: " (the stop came from W4b, now skipped)".
 * Empty when the stop names no step.
 */
export function stopPlace(q: { stop_step?: string; steps: readonly { id: string; status: string }[] }): string {
  const st = q.stop_step ? q.steps.find((s) => s.id === q.stop_step) : undefined;
  if (!st) return "";
  return st.status === "skipped" || st.status === "done" ? ` (the stop came from ${st.id}, now ${st.status})` : ` at step ${st.id}`;
}
