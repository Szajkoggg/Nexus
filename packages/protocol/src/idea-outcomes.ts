// Deterministic quotations, never a synthesized claim of implementation or a new acceptance derivation.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ideaHash } from "./idea-links.ts";
import type { IdeaOutcome } from "./ideas.ts";
import type { QueueView } from "./state.ts";
import type { ProjectStore } from "./store.ts";

function sentences(text: string, count: number): string {
  return (text.trim().replace(/\s+/g, " ").match(/.+?[.!?](?=\s|$)/g) ?? []).slice(0, count).map((s) => s.trim()).join(" ");
}

export function ideaOutcome(store: ProjectStore, q: QueueView): IdeaOutcome {
  const path = `queues/${q.id}/report.md`;
  const fullPath = join(store.dir, path);
  const available = existsSync(fullPath);
  const report = { path: `.nexus/${path}`, available, ...(available ? { hash: ideaHash(readFileSync(fullPath, "utf8")) } : {}), ...(q.report ? { at: q.report.at, event: q.report.event } : {}) };
  const accepted: IdeaOutcome["accepted"] = [];
  const historical: IdeaOutcome["historical"] = [];
  const warnings: string[] = [];
  for (const s of q.steps) {
    // State already handles review policy, reopen, rejection and provisional confirmation. Never infer from timestamps.
    const rounds = s.timeline.filter((e) => e.type === "step.done");
    const done = rounds.at(-1);
    const currentAccepted = s.status === "done" && !(s.provisional && (!s.provisional.confirmed || s.provisional.fix));
    for (const [i, e] of rounds.entries()) if (e.type === "step.done" && (e !== done || !currentAccepted)) historical.push({
      step: s.id, round: i + 1, event: e.id, summary: e.summary, ...(e.commit ? { commit: e.commit } : {}),
    });
    if (!currentAccepted) continue;
    if (!done || done.type !== "step.done" || !s.summary?.trim()) continue;
    accepted.push({ step: s.id, round: rounds.length, event: done.id, summary: s.summary,
      ...(s.commit ? { commit: s.commit } : {}), closing: !!(s.closing || s.integration) });
  }
  if (!available) warnings.push("Full queue report is unavailable; accepted step summaries remain available");
  if (q.steps.some((s) => s.status !== "done" || (s.provisional && (!s.provisional.confirmed || s.provisional.fix)))) warnings.push("Work includes unfinished, skipped or provisionally accepted steps; the report does not confirm implementation");
  const summary = q.report?.summary.trim();
  const substantive_steps = accepted.filter((s) => !s.closing).length;
  const closingOnly = summary && (accepted.some((s) => s.closing && s.summary.trim() === summary)
    || /^(?:closing refactor(?:ing)?|integration|merged? (?:the |this )?(?:branch|queue|worktree))\b/i.test(summary));
  if (summary && !closingOnly && available && sentences(summary, 2)) {
    // A source hash is returned on every read: edits regenerate the excerpt snapshot, never leave a stale cache.
    return { kind: "queue-report", text: sentences(summary, 2), report,
      excerpts: [{ text: sentences(summary, 2), event: q.report!.event, hash: ideaHash({ summary, report: report.hash, at: q.report!.at }) }],
      accepted, historical, sampled_steps: 0, substantive_steps, warnings };
  }
  const substantive = accepted.filter((s) => !s.closing);
  const excerpts = substantive.flatMap((s) => {
    const text = sentences(s.summary, 1);
    return text ? [{ text, step: s.step, round: s.round, event: s.event, ...(s.commit ? { commit: s.commit } : {}), hash: ideaHash(s) }] : [];
  }).slice(0, 2);
  if (closingOnly) warnings.push("The queue report summary only describes closing work; substantive step excerpts are used");
  return { kind: excerpts.length ? "accepted-steps" : "unavailable",
    text: excerpts.length ? excerpts.map((e) => e.text).join(" ") : "No substantive outcome summary available",
    report, excerpts, accepted, historical, sampled_steps: excerpts.length, substantive_steps, warnings };
}
