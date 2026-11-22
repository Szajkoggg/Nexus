// Where a step ran and why, when its runtime's usage ran out (docs/protocol/runtimes.md, "Fallback when usage runs out"): a line per
// switch of the step from its queue's run (run.yaml `fallbacks`), "On Codex (gpt-6-luna, low effort): Claude Code's
// 5-hour window at 96 % (limit 90 %)", and the switch back. In the step's details and on the queue card.
import type { QueueView } from "../api.ts";
import { t } from "../i18n.ts";
import { runtimeName } from "../runtimes.ts";

type Entry = NonNullable<NonNullable<QueueView["run"]>["fallbacks"]>[number];

/** The run's switches of this step, oldest first. */
export const stepSwitches = (queue: Pick<QueueView, "run">, step: string): Entry[] => (queue.run?.fallbacks ?? []).filter((f) => f.step === step);

/** One switch in a sentence: on its fallback (with its model and effort), or back on its own runtime. */
export function switchText(f: Entry): string {
  if (f.back) return t("fallback.back", { runtime: runtimeName(f.runtime), reason: f.reason });
  const values = [f.model, f.effort && t("fallback.effort", { effort: f.effort })].filter(Boolean).join(", ");
  return t("fallback.on", { runtime: runtimeName(f.runtime), values: values ? ` (${values})` : "", reason: f.reason });
}

/** The step's switches as lines, in the step's details. Nothing for a step that never left its own runtime. */
export function StepSwitches({ queue, step }: { queue: Pick<QueueView, "run">; step: string }) {
  const list = stepSwitches(queue, step);
  if (!list.length) return null;
  return (
    <div className="mt-4 rounded-lg border border-info/30 bg-info/10 p-3 text-sm">
      {list.map((f) => (
        <p key={f.at} className="flex gap-2 text-fg">
          <span aria-hidden className="text-info">⇄</span>
          <span>{switchText(f)}</span>
        </p>
      ))}
    </div>
  );
}
