// Approving a queue (UX proposals, 15): what the approval view says besides the steps themselves. Whether a queue waits
// for the user's approval, its run settings on one line, the orchestrator's message that came with its draft, and the
// reference that "Ask the orchestrator…" puts in the composer. Pure and unit tested (test/approval.test.ts).
import type { ChatEntry, ProjectFile, QueueView } from "@nexus/protocol";
import { stepValuesText } from "@nexus/protocol/steps";
import { formatClock, t, type Key } from "./i18n.ts";

/** A queue whose current revision waits for the user's approval: not approved, and neither finished nor cancelled. */
export const needsApproval = (q: Pick<QueueView, "approved" | "status">): boolean =>
  !q.approved && q.status !== "done" && q.status !== "cancelled";

const RUNTIME = { claude: "Claude", codex: "Codex" } as const;
const LEVEL_KEYS: Record<number, Key> = { 1: "approval.level.1", 2: "approval.level.2", 3: "approval.level.3" };
/** How each step is reviewed, by its review level, in words: "wait for my review"; an unknown level as it is. */
export const levelWords = (level: number): string => (LEVEL_KEYS[level] ? t(LEVEL_KEYS[level]) : String(level));

export interface RunSettings {
  /** "4 steps · on main, after SF · Claude, high · after each step: go on", in parts. */
  parts: string[];
  /** The steps that run on their own runtime, model or effort (SF2): "SC3 on Codex · gpt-6-luna". */
  own: string[];
}

/**
 * A queue's run settings as they will apply: where it runs, when it starts (after another queue, at a time), the
 * runtime, model and effort (the run's, else its planned start's, else the project's defaults), what happens after
 * each step, and the steps with values of their own.
 */
export function runSettings(q: Pick<QueueView, "steps" | "branch" | "worktree" | "start" | "run" | "review_level">, project: Pick<ProjectFile, "defaults" | "runtimes">, now = new Date()): RunSettings {
  const n = q.steps.length;
  const where = q.worktree ? (q.branch ? t("approval.run.worktreeOn", { branch: q.branch }) : t("approval.run.worktree")) : q.branch ? t("approval.run.on", { branch: q.branch }) : undefined;
  const when = q.start?.after ? t("approval.run.after", { queue: q.start.after }) : q.start?.at ? t("approval.run.at", { time: formatClock(q.start.at, now) }) : undefined;
  const rt = q.run?.runtime ?? q.start?.runtime ?? project.runtimes.default;
  const model = q.run?.model ?? q.start?.model ?? project.runtimes[rt].model;
  const effort = q.run?.effort ?? q.start?.effort ?? project.runtimes[rt].effort;
  const level = q.review_level ?? project.defaults.review_level;
  return {
    parts: [
      t("approval.run.steps", { count: n }),
      [where, when].filter(Boolean).join(", ") || undefined,
      [RUNTIME[rt], model, effort].filter(Boolean).join(", "),
      t("approval.run.afterEach", { level: levelWords(level) }),
    ].filter((x): x is string => !!x),
    own: q.steps.flatMap((s) => { const values = stepValuesText(s); return values ? [t("approval.run.stepOn", { step: s.id, values })] : []; }),
  };
}

/** A `nexus queue draft` of this queue in a tool call's line ("Bash: nexus queue draft .nexus/drafts/SC.yaml"). */
const draftsQueue = (text: string, queue: string) => {
  if (!/\bnexus(\.cmd)? queue draft\b/.test(text)) return false;
  const esc = queue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s/\\\\"'])${esc}\\.ya?ml\\b`).test(text);
};

/**
 * The orchestrator's draft of a queue, as its chat shows it: when it last ran `nexus queue draft` with that queue's
 * file, and the first message it wrote after that (the message that came with the draft; none yet while it works).
 * None when the chat shows no such draft (a queue imported by hand, a draft sent from stdin).
 */
export function draftOf(chat: readonly ChatEntry[], queue: string): { at: string; message?: ChatEntry } | undefined {
  let i = -1;
  chat.forEach((c, k) => { if (c.from === "orchestrator" && c.kind === "tool" && draftsQueue(c.text, queue)) i = k; });
  if (i < 0) return undefined;
  return { at: chat[i]!.at, message: chat.slice(i + 1).find((c) => c.from === "orchestrator" && c.kind === "message") };
}

/** What approving pins, said beside the button. */
export const pinsText = (revision: number, stopped: boolean) => t(stopped ? "approval.pinsLifts" : "approval.pins", { revision });

/** The reference "Ask the orchestrator…" puts at the start of the composer. */
export const queueReference = (queue: string, revision: number) => t("approval.reference", { queue, revision });

/** The composer's text with the reference at its start: once, before what was already typed. */
export function withReference(text: string, reference: string): string {
  if (text.startsWith(reference)) return text;
  return text.trim() ? `${reference}${text}` : reference;
}
