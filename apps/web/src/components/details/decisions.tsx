// A step's review decisions in its panel and in the picture viewer (queue RVD; docs/design/review-decisions.md, "The
// screens"): each decision a card with its question, why it matters, the material, the options (the recommendation
// marked, never chosen), the user's words and its own Save; a saved one folds to a line with Change. Saving is no
// acceptance: the step is accepted apart, with Accept, once every decision is answered. What holds Accept, and the
// unsaved choices the panel and the viewer share, are in decisions.ts.
import { useRef, useState, useSyncExternalStore } from "react";
import { act, enc, type QueueView, type StepView } from "../../api.ts";
import {
  acceptHold, answeredCount, answererWord, decisionCards, draftId, draftStore, materialFirst, seenAnswers, unsaved, type CardState, type Draft,
} from "../../decisions.ts";
import { t } from "../../i18n.ts";
import { usePage } from "../../page.ts";
import { reviewRound } from "@nexus/protocol/checks";
import { errorText } from "@nexus/protocol/errors";
import type { DecisionAnswer } from "@nexus/protocol/review-decisions";
import { Button, TEXTAREA, TimeAgo } from "../ui.tsx";

/** What the step's decisions are now for the user: the cards, the round, what holds Accept, the answers shown. */
export function useStepDecisions(project: string, queue: QueueView, step: StepView) {
  useSyncExternalStore(draftStore.subscribe, draftStore.version);
  const round = reviewRound(queue, step);
  const cards = decisionCards(step, round);
  const unsavedIds = cards.filter((c) => unsaved(draftStore.get(draftId(project, queue.id, step, c.d, round)), c.current)).map((c) => c.d.id);
  return { round, cards, unsavedIds, hold: acceptHold(cards, unsavedIds), seen: seenAnswers(step, round), ...answeredCount(cards) };
}

type Decisions = ReturnType<typeof useStepDecisions>;

/** Why Accept waits, in words: "2 decisions open (D2, D3): answer them to accept". */
export function holdText(hold: NonNullable<Decisions["hold"]>): string {
  const ids = hold.ids.join(", ");
  switch (hold.kind) {
    case "fix": return t("decisions.hold.fix", { ids });
    case "open": return t("decisions.hold.open", { count: hold.ids.length, ids });
    case "proposal": return t("decisions.hold.proposal", { ids });
    case "unsaved": return t("decisions.hold.unsaved", { ids });
  }
}

/** The card of decision `id` into view, its first control focused (the action bar's "Go to D2"). */
export function goToDecision(id: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-decision="${CSS.escape(id)}"]`);
  if (!card) return false;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  (card.querySelector<HTMLElement>("[role=radio][tabindex='0'], button, textarea") ?? card).focus({ preventScroll: true });
  return true;
}

/** An answer as one line: the option (or "none of the options") and the words in quotes. */
function AnswerText({ a }: { a: DecisionAnswer }) {
  return (
    <span className="break-words">
      <b className="font-semibold text-fg">{a.choice ?? t("decisions.noneOfThem")}</b>
      {a.text && <span className="text-fg-2"> · “{a.text}”</span>}
    </span>
  );
}

interface ListProps {
  project: string; queue: QueueView; step: StepView; decisions: Decisions;
  /** Opens a material (a picture's view key or path) in the viewer, or as a link: undefined when it cannot. */
  material?: (m: string) => { label: string; open: () => void } | undefined;
  /** Only shown: no Change, no Save (a finished step, a read-only queue). */
  readOnly?: boolean;
  /** The picture the viewer shows: the decisions about it first. */
  picture?: { path?: string; key?: string };
  /** The viewer's sheet: no heading of its own. */
  bare?: boolean;
}

/**
 * The step's decisions: "Your decisions · 1 of 3 answered" and a card each; all of them saved, one box with a line
 * each. A list the worker never declared, or its explicit none, in a line. Nothing for a step without either.
 */
export function DecisionList({ project, queue, step, decisions, material, readOnly, picture, bare }: ListProps) {
  const { cards, round, answered, total } = decisions;
  const ids = (c: CardState) => draftId(project, queue.id, step, c.d, round);
  const folded = (c: CardState) => (c.state === "saved" || c.state === "fix" || readOnly) && !draftStore.get(ids(c));
  const change = (c: CardState) => () => draftStore.set(ids(c), draftOf(c.current));
  if (!cards.length) {
    if (step.decision_list === "missing" && step.status === "review") return <p className="mb-4 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-fg-2" data-decisions="missing">{t("decisions.missing")}</p>;
    if (step.decision_list === "none" && step.decisions.none && step.status === "review") return <p className="mb-4 text-sm text-fg-3" data-decisions="none">{t("decisions.none", { text: step.decisions.none.text })}</p>;
    return null;
  }
  const ordered = materialFirst(cards, picture);
  const all = answered === total;
  return (
    <section className={bare ? "" : "mb-6"} aria-label={t("decisions.title")} data-decisions="list">
      {!bare && (
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-3">{t(readOnly ? "decisions.titleDone" : "decisions.title")}</h3>
          {!readOnly && <span data-decisions-count className={`whitespace-nowrap rounded-md px-1.5 py-px text-xs font-semibold ${all ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}>
            {all ? t("decisions.allAnswered", { count: total }) : t("decisions.answered", { answered, total })}
          </span>}
        </div>
      )}
      {ordered.every(folded) ? (
        <div className="rounded-lg border border-line-strong bg-surface px-3">
          {ordered.map((c) => <FoldedLine key={c.d.id} card={c} readOnly={readOnly} onChange={change(c)} />)}
        </div>
      ) : (
        <div className="space-y-2.5">
          {ordered.map((c) => folded(c)
            ? <div key={c.d.id} className="rounded-lg border border-line-strong bg-surface px-3"><FoldedLine card={c} readOnly={readOnly} onChange={change(c)} /></div>
            : <DecisionCard key={`${project}/${queue.id}/${step.id}/${c.d.id}`} project={project} queue={queue.id} step={step} card={c} round={round} draft={ids(c)} material={material} />)}
        </div>
      )}
    </section>
  );
}

/** The user's own answer as a draft to change (Change), else an empty one. */
const draftOf = (a: DecisionAnswer | undefined): Draft => (a?.by === "user" ? { ...(a.choice ? { choice: a.choice } : {}), words: a.text ?? "" } : { words: "" });

/** A saved decision in one line: the question, the answer, who and when; Change opens its card again. */
function FoldedLine({ card: c, readOnly, onChange }: { card: CardState; readOnly?: boolean; onChange: () => void }) {
  const a = c.current;
  return (
    <div data-decision={c.d.id} data-state={c.state} className="flex items-start gap-2 border-t border-line py-2 text-sm first:border-t-0">
      <span className="shrink-0 font-mono text-xs leading-5 text-fg-3">{c.d.id}</span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-fg-2">{c.d.text}</p>
        {a ? <p><AnswerText a={a} /></p> : <p className="text-fg-3">{t("decisions.notAnswered")}</p>}
        {a && <p className="text-xs text-fg-3">
          {c.state === "fix" ? <span className="text-warn">{t("decisions.asksFix")} · </span> : <span className="text-ok">✓ {t("decisions.saved")} · </span>}
          {answererWord(a.by)}{a.provisional ? ` · ${t("decisions.provisional")}` : ""} · <TimeAgo at={a.at} />
        </p>}
      </div>
      {!readOnly && <button type="button" onClick={onChange} className="shrink-0 text-xs text-accent hover:underline max-lg:min-h-11" aria-label={t("decisions.changeLabel", { id: c.d.id })}>{t("decisions.change")}</button>}
    </div>
  );
}

/** One open decision: the question, why, material, the options, the user's words and Save. */
function DecisionCard({ project, queue, step, card: c, round, draft: id, material }: {
  project: string; queue: string; step: StepView; card: CardState; round: number; draft: string;
  material?: ListProps["material"];
}) {
  const { reload } = usePage();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const draft = draftStore.get(id) ?? { words: "" };
  const set = (d: Draft) => draftStore.set(id, d.choice || d.words ? d : (c.state === "saved" || c.state === "fix") ? d : undefined);
  const options = c.d.options;
  const pending = unsaved(draftStore.get(id), c.current);
  const save = async (answer: { choice?: string; text?: string }) => {
    // Guarded synchronously: two clicks can arrive before React renders busy.
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(undefined);
    try {
      await act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step.id)}/decisions/${enc(c.d.id)}/answer`, {
        version: c.d.version, round, ...(answer.choice ? { choice: answer.choice } : {}), ...(answer.text?.trim() ? { text: answer.text } : {}),
      });
      draftStore.set(id, undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      saving.current = false; setBusy(false);
      reload();
    }
  };
  const submit = () => { if (pending && !busy) void save({ choice: draft.choice, text: draft.words }); };
  const mat = c.d.material.map((m) => ({ m, link: material?.(m) }));
  return (
    <div data-decision={c.d.id} data-state={c.state} className="rounded-lg border border-line-strong bg-surface px-3 py-2.5">
      <p className="break-words text-sm font-semibold leading-snug text-fg"><span className="mr-1.5 font-mono font-medium text-fg-3">{c.d.id}</span>{c.d.text}</p>
      {(c.d.why || mat.length > 0) && (
        <p className="mt-0.5 break-words text-xs text-fg-2">
          {c.d.why}
          {mat.map(({ m, link }) => link
            ? <button key={m} type="button" onClick={link.open} className="ml-1.5 text-accent hover:underline">{t("decisions.view", { label: link.label })}</button>
            : <span key={m} className="ml-1.5 font-mono text-fg-3">{m}</span>)}
        </p>
      )}
      {c.stale && <p className="mt-1.5 text-xs text-warn">{t("decisions.stale", { answer: c.stale.choice ?? c.stale.text ?? "" })}</p>}
      {c.state === "proposal" && c.current && (
        <div className="mt-2 rounded-md border border-review/30 bg-review/5 px-2.5 py-1.5 text-sm">
          <p className="text-xs text-fg-3">{t("decisions.proposal")}</p>
          <p><AnswerText a={c.current} /></p>
          <button type="button" disabled={busy} onClick={() => void save({ choice: c.current!.choice, text: c.current!.text })} className="mt-1 text-xs font-medium text-accent hover:underline disabled:opacity-40 max-lg:min-h-11">{t("decisions.adopt")}</button>
        </div>
      )}
      {c.earlier && !c.current && (
        <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs text-fg-2">
          <span>{t("decisions.earlier", { round: c.earlier.round, who: answererWord(c.earlier.by) })} <AnswerText a={c.earlier} /></span>
          {c.earlier.choice && options.some((o) => o.label === c.earlier!.choice) && (
            <button type="button" disabled={busy} onClick={() => void save({ choice: c.earlier!.choice, text: c.earlier!.text })} className="font-medium text-accent hover:underline disabled:opacity-40 max-lg:min-h-11">
              {t("decisions.same", { round: c.earlier.round, option: c.earlier.choice })}
            </button>
          )}
        </p>
      )}
      <div className="mt-2 space-y-1.5" role="radiogroup" aria-label={t("decisions.options", { id: c.d.id })}>
        {options.map((o, i) => {
          const on = draft.choice === o.label;
          return (
            <button key={o.label} type="button" role="radio" aria-checked={on} disabled={busy}
              tabIndex={i === Math.max(0, options.findIndex((x) => x.label === draft.choice)) ? 0 : -1}
              onClick={() => set({ ...draft, choice: on ? undefined : o.label })}
              onKeyDown={(e) => {
                const step = ["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 0;
                if (!step && e.key !== "Home" && e.key !== "End") return;
                e.preventDefault();
                const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : (i + step + options.length) % options.length;
                set({ ...draft, choice: options[next]!.label });
                (e.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
              }}
              className={`flex min-h-10 w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-lg:min-h-11 ${on ? "border-accent bg-accent/10" : "border-line-strong bg-surface-2 hover:bg-surface-3"}`}>
              <span aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${on ? "border-accent bg-accent shadow-[inset_0_0_0_2px_var(--color-surface-2)]" : "border-fg-3"}`} />
              <span className="min-w-0 flex-1 break-words">{o.label}</span>
              {(o.label === c.d.recommended || o.effect === "fix") && (
                <span className="flex shrink-0 flex-col items-end text-[11px] leading-tight">
                  {o.label === c.d.recommended && <span className="text-accent">{t("decisions.recommended")}</span>}
                  {o.effect === "fix" && <span className="text-warn">{t("decisions.fixOption")}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <textarea value={draft.words} rows={1} disabled={busy} onChange={(e) => set({ ...draft, words: e.target.value })}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
        aria-label={t("decisions.wordsLabel", { id: c.d.id })} placeholder={t(draft.choice ? "decisions.why" : "decisions.ownWords")}
        className={`mt-2 ${TEXTAREA}`} />
      {error && <p role="alert" className="mt-1.5 text-xs text-danger">{t("decisions.notSaved", { error })}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-3">
        <span className={pending ? "text-warn" : ""} data-draft={pending ? "unsaved" : "none"}>
          {busy ? t("decisions.saving") : pending ? t("decisions.unsaved") : c.state === "fix" || c.state === "saved" ? t("decisions.editing") : t("decisions.notAnswered")}
        </span>
        <span className="flex-1" />
        {draftStore.get(id) && <Button variant="quiet" action="cancel" disabled={busy} onClick={() => draftStore.set(id, undefined)}>{t("common.cancel")}</Button>}
        <Button action="save" disabled={!pending || busy} onClick={submit}>{t("decisions.save")}</Button>
      </div>
    </div>
  );
}
