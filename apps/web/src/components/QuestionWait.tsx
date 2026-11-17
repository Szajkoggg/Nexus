// One waiting reason for the desktop cards, phone sheet and queue controls.
import { questionBarrier } from "@nexus/protocol/status-rules";
import type { QueueView } from "../api.ts";
import { t } from "../i18n.ts";

export function QuestionWait({ queue, step }: { queue: QueueView; step?: string }) {
  if (!step || !queue.questions.some(q => q.step === step)) return null;
  const b = questionBarrier(queue.questions, queue.id, step, queue.run?.answers_resumed);
  return <p role="status" data-question-wait data-remaining={b.remaining} className="mb-3 rounded-lg bg-surface-2 p-3 text-sm text-fg-2">
    {b.remaining ? t("details.question.remaining", { count: b.remaining })
      : t(b.wait ? "details.question.explicitWait" : "details.question.allAnswered")}
  </p>;
}
