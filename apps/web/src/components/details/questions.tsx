// Answering a question, in the three places that do it: the phone's question sheet, the drawer's action bar, and the
// answer box in a question's card. One hook (useAnswer) holds what they share: the draft, "the worker may go on", and
// sending the answer.
import { useRef, useState, type ReactNode } from "react";
import { act, enc, type QuestionView } from "../../api.ts";
import { answerText, questionState } from "../../details.ts";
import { draftKey } from "../../drafts.ts";
import { t } from "../../i18n.ts";
import { isOpenQuestion } from "@nexus/protocol/status-rules";
import { ActionBar, Button, Markdown, PanelBody, StatusBadge, TEXTAREA, TimeAgo, useDraftText } from "../ui.tsx";
import { usePage } from "../../page.ts";

interface AnswerProps { q: QuestionView; project: string }

/** One question's selection, words and send action. Callers key the form by project and qid. */
function useAnswer({ q, project }: AnswerProps) {
  const { reload: onChanged } = usePage();
  const [goOn, setGoOn] = useState(true);
  const draft = draftKey(project, "answer", q.qid);
  const [choice, setChoice] = useState<string | undefined>(() => {
    const option = chosen.get(draft); chosen.delete(draft);
    return q.options?.includes(option ?? "") ? option : undefined;
  });
  const submitting = useRef(false);
  const d = useDraftText({
    draft, allowEmpty: true,
    onSubmit: async (words) => {
      const text = answerText(choice, words);
      if (!text) throw new Error(t("details.answer.empty"));
      await act(project, "POST", `/questions/${enc(q.qid)}/answer`, { text, continue: goOn });
      setChoice(undefined);
      onChanged();
    },
  });
  const ready = !d.busy && (!!choice || !!d.text.trim());
  const submit = async () => {
    // Guard synchronously too: two clicks or keyboard events can arrive before React renders busy.
    if (!ready || submitting.current) return;
    submitting.current = true;
    try { await d.submit(); } finally { submitting.current = false; }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
  };
  return { ...d, goOn, setGoOn, choice, setChoice, ready, submit, onKeyDown };
}

type Answer = ReturnType<typeof useAnswer>;

/** The same single choice on the phone, in the action bar and in other questions' cards. */
function AnswerFields({ q, answer: a }: { q: QuestionView; answer: Answer }) {
  const options = q.options ?? [];
  return (
    <>
      {!!options.length && (
        <div className="my-3 space-y-2.5" role="radiogroup" aria-label={t("details.question.options")}>
          {options.map((o, i) => (
            <button key={o} type="button" role="radio" aria-checked={a.choice === o} disabled={a.busy}
              tabIndex={i === Math.max(0, options.indexOf(a.choice ?? "")) ? 0 : -1}
              onClick={() => a.setChoice(a.choice === o ? undefined : o)}
              onKeyDown={(e) => {
                const direction = ["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 0;
                if (!direction && e.key !== "Home" && e.key !== "End") return;
                e.preventDefault();
                const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : (i + direction + options.length) % options.length;
                a.setChoice(options[next]);
                (e.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
              }}
              className={`flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-[15px] text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${a.choice === o ? "border-accent bg-accent/10 ring-1 ring-accent" : "border-line-strong bg-surface-2 hover:bg-surface-3"}`}>
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs ${a.choice === o ? "bg-accent-strong text-on-accent" : "bg-surface-3 text-fg-2"}`}>{i + 1}</span>
              <span className="min-w-0 flex-1 break-words">
                {o}
                {(q.recommended === o || a.choice === o) && <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-accent">
                  {q.recommended === o && <span>{t("details.question.recommended")}</span>}
                  {a.choice === o && <span>{t("details.question.chosen")}</span>}
                </span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea value={a.text} rows={2} onChange={(e) => a.change(e.target.value)} onKeyDown={a.onKeyDown}
        aria-label={t("details.answer.placeholder")}
        placeholder={t(options.length ? (a.choice ? "details.answer.addWords" : "details.answer.ownWords") : "details.answer.placeholder")}
        className={`mt-2 ${TEXTAREA}`} />
      <label className="mt-1 flex min-h-11 items-center gap-2 text-sm text-fg-2">
        <input type="checkbox" checked={a.goOn} onChange={(e) => a.setGoOn(e.target.checked)} className="h-4 w-4 accent-accent" />
        {t("details.answer.mayGoOn")}
      </label>
    </>
  );
}

function AnswerButton({ answer: a }: { answer: Answer }) {
  return <Button onClick={() => void a.submit()} disabled={!a.ready}>{a.busy ? t("ui.sending") : t("details.answer.button")}</Button>;
}

/**
 * An option the user tapped in a waiting card, for the question's sheet to open with it chosen (the user confirms
 * there). Kept in memory until the sheet takes it.
 */
const chosen = new Map<string, string>();
export const chooseOption = (project: string, qid: string, option: string) => { chosen.set(draftKey(project, "answer", qid), option); };

/**
 * A question's sheet on the phone: the question first (what kind, whether the worker waits, since when), what the
 * orchestrator said passing it on, the options as 48 px buttons, the user's own words, then the step's details
 * (`children`); Answer in the action bar. An option and words go together: the option, then the words.
 */
export function QuestionSheet({ children, ...props }: AnswerProps & { children: ReactNode }) {
  const { q } = props;
  const answer = useAnswer(props);
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
        <div data-answer-qid={q.qid}><AnswerFields q={q} answer={answer} /></div>
        <div className="mt-6 border-t border-line pt-4">{children}</div>
      </PanelBody>
      <ActionBar
        hint={answer.error ? <span className="text-danger">{answer.error}</span> : answer.choice ? t(answer.text.trim() ? "details.answer.answersWithWords" : "details.answer.answers", { option: answer.choice }) : undefined}
        primary={<AnswerButton answer={answer} />}
      />
    </>
  );
}

/** The bar of a step with an open question: the answer box, whether the worker may go on, and Answer. */
export function AnswerBar(props: AnswerProps) {
  const answer = useAnswer(props);
  return (
    <ActionBar
      hint={answer.error ? <span className="text-danger">{answer.error}</span> : t("details.answer.ctrlEnter")}
      primary={<AnswerButton answer={answer} />}
    >
      <div data-answer-qid={props.q.qid}>
        <p className="mb-2 text-sm font-medium text-fg">{props.q.text}</p>
        <AnswerFields q={props.q} answer={answer} />
      </div>
    </ActionBar>
  );
}

/** A question and its answers; open, with its answer box, unless the panel's action bar answers it (`inBar`). */
export function Question({ q, project, inBar }: AnswerProps & { inBar?: boolean }) {
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
      {q.options && (!open || inBar) && (
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
          <AnswerBox key={draftKey(project, "answer", q.qid)} q={q} project={project} />
        </div>
      )}
    </div>
  );
}

/** The answer box in a question's card. */
function AnswerBox(props: AnswerProps) {
  const answer = useAnswer(props);
  return (
    <div data-answer-qid={props.q.qid}>
      <AnswerFields q={props.q} answer={answer} />
      {answer.error && <p role="alert" className="mb-2 text-sm text-danger">{answer.error}</p>}
      <div className="flex justify-end"><AnswerButton answer={answer} /></div>
    </div>
  );
}
