// Answering a question, in the three places that do it: the phone's question sheet, the drawer's action bar, and the
// answer box in a question's card. One hook (useAnswer) holds what they share: the draft, "the worker may go on", and
// sending the answer.
import { useState, type ReactNode } from "react";
import { act, enc, type QuestionView } from "../../api.ts";
import { answerText, questionState } from "../../details.ts";
import { draftKey } from "../../drafts.ts";
import { t } from "../../i18n.ts";
import { isOpenQuestion } from "@nexus/protocol/status-rules";
import { ActionBar, Button, Composer, Markdown, PanelBody, StatusBadge, TEXTAREA, TimeAgo, useDraftText } from "../ui.tsx";

interface AnswerProps { q: QuestionView; project: string; onChanged: () => void }

/**
 * An answer to a question: its draft, whether the worker may go on after it (on by default), and `send`, which posts
 * the answer and then reloads.
 */
function useAnswer({ q, project, onChanged }: AnswerProps) {
  const [goOn, setGoOn] = useState(true);
  return {
    goOn, setGoOn,
    draft: draftKey(project, "answer", q.qid),
    send: async (text: string) => { await act(project, "POST", `/questions/${enc(q.qid)}/answer`, { text, continue: goOn }); onChanged(); },
  };
}

/**
 * An option the user tapped in a waiting card, for the question's sheet to open with it chosen (the user confirms
 * there). Kept in memory until the sheet takes it.
 */
const chosen = new Map<string, string>();
export const chooseOption = (qid: string, option: string) => { chosen.set(qid, option); };

/**
 * A question's sheet on the phone: the question first (what kind, whether the worker waits, since when), what the
 * orchestrator said passing it on, the options as 48 px buttons, the user's own words, then the step's details
 * (`children`); Answer in the action bar. An option and words go together: the option, then the words.
 */
export function QuestionSheet({ children, ...props }: AnswerProps & { children: ReactNode }) {
  const { q } = props;
  const [choice, setChoice] = useState<string | undefined>(() => { const c = chosen.get(q.qid); chosen.delete(q.qid); return c; });
  const answer = useAnswer(props);
  const d = useDraftText({
    draft: answer.draft, allowEmpty: true,
    onSubmit: async (words) => {
      const text = answerText(choice, words);
      if (!text) throw new Error(t("details.answer.empty"));
      await answer.send(text);
    },
  });
  const ready = !d.busy && (!!choice || !!d.text.trim());
  const passed = q.answers.filter((a) => a.escalate);
  return (
    <>
      <PanelBody>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <StatusBadge status={q.state === "escalated" ? "review" : "waiting"} label={t(q.state === "escalated" ? "details.question.passed" : "details.question.forYou")} className="text-sm" />
          <span className="text-fg-3">· {t(q.can_continue ? "details.question.goesOn" : "details.question.waits")} · <TimeAgo at={q.asked_at} /></span>
        </div>
        <h1 className="mt-3 text-[19px] font-semibold leading-snug text-fg">{q.text}</h1>
        {passed.map((a) => (
          <div key={a.id} className="mt-3 border-l-2 border-accent py-1 pl-3 text-sm text-fg">
            <span className="text-fg-3">{t("details.question.orchestrator")} </span><Markdown className="inline [&_p]:inline [&_p]:m-0">{a.text}</Markdown>
          </div>
        ))}
        {!!q.options?.length && (
          <div className="mt-4 space-y-2.5" role="radiogroup" aria-label={t("details.question.options")}>
            {q.options.map((o, i) => (
              <button key={o} role="radio" aria-checked={choice === o} onClick={() => setChoice(choice === o ? undefined : o)}
                className={`flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-[15px] text-fg ${choice === o ? "border-accent bg-accent/10 ring-1 ring-accent" : "border-line-strong bg-surface-2 hover:bg-surface-3"}`}>
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs ${choice === o ? "bg-accent-strong text-on-accent" : "bg-surface-3 text-fg-2"}`}>{i + 1}</span>
                <span className="min-w-0 flex-1">{o}</span>
                {q.recommended === o && <span className="shrink-0 text-xs text-accent">{t("details.question.recommended")}</span>}
                {choice === o && <span className="shrink-0 text-xs text-accent">{q.recommended === o ? "· " : ""}{t("details.question.chosen")}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea value={d.text} rows={2} onChange={(e) => d.change(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (ready) void d.submit(); } }}
          placeholder={t(q.options?.length ? (choice ? "details.answer.addWords" : "details.answer.ownWords") : "details.answer.placeholder")}
          className={`mt-4 ${TEXTAREA}`} />
        <label className="mt-1 flex min-h-11 items-center gap-2 text-sm text-fg-2">
          <input type="checkbox" checked={answer.goOn} onChange={(e) => answer.setGoOn(e.target.checked)} className="h-4 w-4 accent-accent" />
          {t("details.answer.mayGoOn")}
        </label>
        <div className="mt-6 border-t border-line pt-4">{children}</div>
      </PanelBody>
      <ActionBar
        hint={d.error ? <span className="text-danger">{d.error}</span> : choice ? t(d.text.trim() ? "details.answer.answersWithWords" : "details.answer.answers", { option: choice }) : undefined}
        primary={<Button onClick={() => void d.submit()} disabled={!ready}>{d.busy ? t("ui.sending") : t("details.answer.button")}</Button>}
      />
    </>
  );
}

/** The bar of a step with an open question: the answer box, whether the worker may go on, and Answer. */
export function AnswerBar(props: AnswerProps) {
  const answer = useAnswer(props);
  const d = useDraftText({ draft: answer.draft, onSubmit: answer.send });
  return (
    <ActionBar
      hint={d.error ? <span className="text-danger">{d.error}</span> : t("details.answer.ctrlEnter")}
      primary={<Button onClick={() => void d.submit()} disabled={!d.ready}>{d.busy ? t("ui.sending") : t("details.answer.button")}</Button>}
    >
      <textarea value={d.text} rows={2} placeholder={t("details.answer.placeholder")} onChange={(e) => d.change(e.target.value)} onKeyDown={d.onKeyDown} className={TEXTAREA} />
      <label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-2">
        <input type="checkbox" checked={answer.goOn} onChange={(e) => answer.setGoOn(e.target.checked)} className="accent-accent" />
        {t("details.answer.mayGoOn")}
      </label>
    </ActionBar>
  );
}

/** A question and its answers; open, with its answer box, unless the panel's action bar answers it (`inBar`). */
export function Question({ q, project, onChanged, inBar }: AnswerProps & { inBar?: boolean }) {
  const open = isOpenQuestion(q);
  const tone = q.state === "escalated" ? "border-review/40 bg-review/5" : open ? "border-warn/30 bg-warn/5" : "border-line";
  return (
    <div className={`mb-2 rounded-lg border p-3 text-sm ${tone}`}>
      <div className="mb-1 flex flex-wrap gap-2 text-xs text-fg-3">
        <StatusBadge status={q.state === "open" ? "waiting" : q.state === "escalated" ? "review" : "done"} label={q.state === "escalated" ? t("details.question.stateForYou") : questionState(q.state)} />
        {q.queue && <span className="font-mono">{q.queue}{q.step ? `/${q.step}` : ""}</span>}
        <span>{t(q.can_continue ? "details.question.goesOn" : "details.question.waits")}</span>
        <span className="ml-auto"><TimeAgo at={q.asked_at} /></span>
      </div>
      <p className="text-fg">{q.text}</p>
      {q.options && (
        <ul className="mt-1 list-disc pl-5 text-fg-2">
          {q.options.map((o) => <li key={o}>{o}{q.recommended === o && <span className="ml-2 text-xs text-accent">{t("details.question.recommended")}</span>}</li>)}
        </ul>
      )}
      {q.answers.map((a) => (
        <div key={a.id} className="mt-2 border-t border-line pt-2 text-fg">
          <span className="text-fg-3">{a.escalate ? t("details.question.passedBy") : t("details.question.answerBy", { by: a.by })} </span>
          <Markdown className="inline [&_p]:inline [&_p]:m-0">{a.text}</Markdown>
        </div>
      ))}
      {open && !inBar && (
        <div className="mt-3">
          <AnswerBox q={q} project={project} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

/** The answer box in a question's card. */
function AnswerBox(props: AnswerProps) {
  const answer = useAnswer(props);
  return (
    <Composer
      rows={2}
      draft={answer.draft}
      placeholder={t("details.answer.placeholder")}
      button={t("details.answer.button")}
      extra={
        <label className="flex items-center gap-1.5 text-xs text-fg-2">
          <input type="checkbox" checked={answer.goOn} onChange={(e) => answer.setGoOn(e.target.checked)} className="accent-accent" />
          {t("details.answer.mayGoOn")}
        </label>
      }
      onSubmit={answer.send}
    />
  );
}
