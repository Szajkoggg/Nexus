// The checks Nexus runs after a worker's `nexus step done` (docs/PROTOCOL.md, "Checks run by Nexus"; queue EC), as the
// dashboard says them: a step's word while they wait for the machine or run, its check-fix round apart from its review
// (send-back) rounds, and the latest set's checks one by one. Pure; the step's status itself is the derivation's
// (packages/protocol/src/checks.ts).
import type { CheckSet } from "@nexus/protocol";
import type { StepView } from "./api.ts";
import { formatClock, t } from "./i18n.ts";

type CheckStep = Pick<StepView, "status" | "checking" | "check_fix" | "check_fix_limit" | "check_limit">;

/** The status whose colours a step shows: a step whose checks wait for the machine is `queued`, quieter than at work. */
export function checkTone(step: Pick<StepView, "status" | "checking">): string {
  return step.status === "checking" && step.checking?.phase === "queued" ? "queued" : step.status;
}

/** "check fix 1 of 3" (or "check fix 1" without the limit): a step's check-fix round, never called a review round. */
function checkFixWords(step: Pick<StepView, "check_fix" | "check_fix_limit">): string | undefined {
  if (!step.check_fix) return undefined;
  return step.check_fix_limit !== undefined
    ? t("state.checkFixOf", { fix: step.check_fix, limit: step.check_fix_limit })
    : t("state.checkFix", { fix: step.check_fix });
}

/**
 * A step's word where the checks Nexus runs decide it: "checks queued", "checks running", "checks on the base",
 * "waiting: orchestrator decides", "check fix 1 of 3"; undefined otherwise (the status's own word).
 */
export function checkWord(step: CheckStep): string | undefined {
  if (step.status === "checking") {
    const phase = step.checking?.phase;
    return t(phase === "queued" ? "state.checksQueued" : phase === "base" ? "state.checksOnBase" : "state.checksRunning");
  }
  if (step.status === "waiting" && step.checking?.phase === "decision") return t("state.checkDecision");
  if (step.status === "running") return checkFixWords(step);
  return undefined;
}

/** What the checks do now, in a line under the step: "npm test since 14:02", "waiting for the machine since 14:01". */
export function checkLine(step: CheckStep, now = new Date()): string | undefined {
  const c = step.checking;
  if (!c || (step.status !== "checking" && step.status !== "waiting")) return undefined;
  const time = formatClock(c.since, now);
  switch (c.phase) {
    case "queued": return t("checks.line.queued", { time });
    case "running": return c.check ? t("checks.line.running", { check: c.check, time }) : t("checks.line.starting", { time });
    case "base": return t("checks.line.base", { check: c.check ?? t("checks.disputed"), time });
    case "decision": return t("checks.line.decision");
  }
}

export type CheckRowState = "passed" | "flaky" | "failed" | "running" | "waiting" | "interrupted";

/** One check of a set as a row: its state now, its time once it ended, the failing tests' names. */
export interface CheckRow { name: string; state: CheckRowState; duration?: number; tests: readonly string[]; log?: string }

/**
 * The set's checks as rows, in the order they run: what passed, failed or is running, and what waits its turn (the
 * step's opening lists them all; a check not reached yet has no run).
 */
export function checkRows(set: CheckSet, names: readonly string[]): CheckRow[] {
  const all = [...set.checks.map((c) => c.name), ...names.filter((n) => !set.checks.some((c) => c.name === n))];
  return all.map((name) => {
    const c = set.checks.find((x) => x.name === name);
    const last = c?.runs.at(-1);
    if (!c || !last) return { name, state: "waiting", tests: [] };
    if (!last.ended_at) return { name, state: "running", tests: [] };
    if (last.interrupted) return { name, state: "interrupted", tests: [] };
    const state: CheckRowState = c.ok ? (c.flaky ? "flaky" : "passed") : c.ok === false ? "failed" : "running";
    return { name, state, duration: last.duration, tests: last.failed_tests ?? [], log: state === "failed" ? last.log : undefined };
  });
}
