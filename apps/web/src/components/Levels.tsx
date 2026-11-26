// Review levels, provisional acceptances and away mode in the dashboard (docs/protocol/review.md, "Review"): the level picker of
// the approval view, a step's level and provisional mark on its line and panel, Confirm and Fix it on a provisional
// acceptance (the return batch and the step), and the away-mode switch with its "until HH:MM" field and its sign.
import { useEffect, useState } from "react";
import { act, actResult, enc, projectUrl, request, useAction, type AttentionItem, type StepView } from "../api.ts";
import { insteadText } from "../decisions.ts";
import { Button, TEXTAREA, TimeAgo } from "./ui.tsx";
import { formatClock, t } from "../i18n.ts";
import { usePage } from "../page.ts";
import { runtimeName } from "../runtimes.ts";

type Level = 1 | 2 | 3;
const LEVELS: Level[] = [1, 2, 3];
const SHORT = { 1: "level.short.1", 2: "level.short.2", 3: "level.short.3" } as const;
const TITLE = { 1: "level.title.1", 2: "level.title.2", 3: "level.title.3" } as const;

/** A level's short words: "You review", "Orchestrator checks", "Goes on". */
export const levelShort = (level: number) => t(SHORT[level as Level] ?? SHORT[2]);
/** What a level means, in a sentence (a tooltip). */
export const levelTitle = (level: number) => t(TITLE[level as Level] ?? TITLE[2]);

/** The away mode as GET /api/server gives it. */
export interface Away { on: boolean; since?: string; until?: string }

// ---------------------------------------------------------------- levels

/**
 * A step's review level, to set before approval or later, until its review is over (levelChangeable): 1 · 2 · 3 as
 * one control, the chosen level's words beside it, and "set by you" with Reset when the user set it. Setting a level
 * asks for no new approval.
 */
export function LevelPicker({ project, queue, step, away }: {
  project: string; queue: string; step: Pick<StepView, "id" | "level" | "level_from">; away?: Away;
}) {
  const { reloaded } = usePage();
  const { busy, error, run } = useAction();
  // The level asked for shows at once and stays, the picker in progress, until the state after the write shows it
  // (page.ts, reloaded); a failure shows the level as it is again, with why.
  const [asked, setAsked] = useState<Level>();
  const set = (level: Level | null) => {
    if (level !== null) setAsked(level);
    void run(async () => {
      try { await act(project, "PUT", `/queues/${enc(queue)}/steps/${enc(step.id)}/level`, { level }); await reloaded(projectUrl(project, "/state")); }
      finally { setAsked(undefined); }
    });
  };
  const shown = asked ?? step.level;
  const mine = step.level_from === "user";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" onClick={(e) => e.stopPropagation()}>
      <span className="text-fg-3">{t("level.label")}</span>
      <span role="radiogroup" aria-label={t("level.pickerLabel", { step: step.id })} aria-busy={busy}
        className={`inline-flex overflow-hidden rounded-md border border-line-strong ${busy ? "opacity-60" : ""}`}>
        {LEVELS.map((l) => (
          <button key={l} type="button" role="radio" aria-checked={shown === l} disabled={busy} title={levelTitle(l)}
            onClick={() => { if (shown !== l) set(l); }}
            className={`min-w-7 px-2 py-0.5 font-mono max-lg:min-h-9 max-lg:min-w-9 ${l > 1 ? "border-l border-line-strong" : ""} ${shown === l ? "bg-accent/20 font-semibold text-fg" : "text-fg-3 enabled:hover:bg-surface-3 enabled:hover:text-fg"}`}>
            {l}
          </button>
        ))}
      </span>
      <span className="text-fg-2" title={levelTitle(shown)}>{levelShort(shown)}</span>
      {away?.on && shown === 2 && <span className="text-review">{t("level.awayAs3")}</span>}
      {mine && <span className="text-accent">{t("level.setByYou")}</span>}
      {mine && <button type="button" onClick={() => set(null)} disabled={busy} className="text-fg-3 underline-offset-2 hover:text-fg hover:underline">{t("level.reset")}</button>}
      {error && <span className="basis-full text-danger">{error}</span>}
    </span>
  );
}

/**
 * Whether the user may still change a step's level: until its review is over (done, also provisionally), it is skipped,
 * failed or rejected. Pending, running, waiting, in review and stopped steps take a new level, also after approval.
 */
export const levelChangeable = (s: Pick<StepView, "status">) => !["done", "skipped", "failed", "rejected"].includes(s.status);

/** A step's level on its line ("L1"), marked when the user set it; level 2, the usual, shows nothing on a line. */
export function LevelMark({ step, always }: { step: Pick<StepView, "level" | "level_from">; always?: boolean }) {
  if (!always && step.level === 2 && step.level_from !== "user") return null;
  return (
    <span title={`${levelTitle(step.level)}${step.level_from === "user" ? ` (${t("level.setByYou")})` : ""}`}
      className={`rounded px-1 font-mono text-[11px] ${step.level === 3 ? "bg-review/15 text-review" : step.level === 1 ? "bg-info/15 text-info" : "bg-surface-3 text-fg-2"} ${step.level_from === "user" ? "ring-1 ring-accent/50" : ""}`}>
      {t("level.badge", { level: String(step.level) })}
    </span>
  );
}

// ---------------------------------------------------------------- who accepted a step (queue RH)

/**
 * Who accepted the step, and on what (queue RH, H17): the user, the orchestrator, the review helper with its runtime,
 * model and effort, or Nexus (an integration without a model); while the review helper reviews it, that. Undefined
 * otherwise.
 */
export function acceptedWord(s: Pick<StepView, "status" | "accepted" | "helper">): { parts: string[]; title?: string } | undefined {
  if (s.status === "review" && s.helper?.state === "running") return { parts: [t("accepted.helperReviews")] };
  const a = s.accepted;
  if (s.status !== "done" || !a) return undefined;
  const on = [a.runtime && runtimeName(a.runtime), a.model, a.effort].filter((x): x is string => !!x);
  const text = t(`accepted.by.${a.by}`);
  return { parts: a.by === "helper" || (a.by === "orchestrator" && a.model) ? [text, ...on] : [text], title: t("accepted.title", { at: new Date(a.at).toLocaleString() }) };
}

// ---------------------------------------------------------------- provisional acceptances

/** A provisional acceptance the user has not dealt with yet. */
export const pendingProvisional = (s: Pick<StepView, "provisional">) => !!s.provisional && !s.provisional.confirmed && !s.provisional.fix;

/** A step's provisional mark in words: waiting for you, confirmed, or fix asked; undefined without one. */
export function provisionalWord(s: Pick<StepView, "provisional">): string | undefined {
  if (!s.provisional) return undefined;
  return s.provisional.fix ? t("provisional.fixAsked") : s.provisional.confirmed ? t("provisional.confirmedWord") : t("provisional.word");
}

/**
 * Confirm and Fix it on one provisional acceptance. Confirm is one click; Fix it opens a box for what to fix, sent as
 * the step's send-back (the orchestrator drafts a step that fixes it). `onDone` after either.
 */
export function ProvisionalActions({ project, queue, step, onDone, wide, preset }: {
  project: string; queue: string; step: string; onDone: () => void; wide?: boolean;
  /** Opens Fix it with this text written in (the return batch's "Instead…"); a new object with each click. */
  preset?: { text: string };
}) {
  const [fixing, setFixing] = useState(false);
  const [text, setText] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (!preset) return;
    setFixing(true);
    setText((old) => (old.trim() ? `${old.trimEnd()} ${preset.text}` : preset.text));
  }, [preset]);
  const go = (path: string, body: unknown) => void run(
    () => actResult(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/${path}`, body),
    () => { setFixing(false); setText(""); onDone(); },
  );
  return (
    <div className={wide ? "space-y-2" : "space-y-1.5"} onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => go("confirm", {})}>{t("provisional.confirm")}</Button>
        {!fixing && <Button variant="quiet" disabled={busy} onClick={() => setFixing(true)}>{t("provisional.fix")}</Button>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      {fixing && (
        <div className="space-y-1.5">
          <textarea autoFocus value={text} rows={2} placeholder={t("provisional.fixPlaceholder")} aria-label={t("provisional.fixLabel", { step })}
            onChange={(e) => setText(e.target.value)} className={TEXTAREA} />
          <div className="flex gap-2">
            <Button disabled={busy || !text.trim()} onClick={() => go("send-back", { text: text.trim() })}>{t("provisional.fixSend")}</Button>
            <Button variant="quiet" onClick={() => { setFixing(false); setText(""); }}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

type BatchStep = NonNullable<AttentionItem["provisional"]>[number];

/**
 * The return batch's steps, in the "waiting for you" list: each with its queue and step, what the orchestrator said
 * the user should look at, the answers its review gave to the step's decisions (queue RVD: who, when, why, "while you
 * were away"; Instead… opens Fix it with the other choice written in), Open, and Confirm or Fix it right there. With
 * more than one step, Confirm all, after a confirmation that lists the orchestrator's answers to the user's decisions.
 */
export function BatchRows({ project, item, onOpen, onChanged, className = "px-3.5 pb-3" }: {
  project: string; item: AttentionItem; onOpen: (queue: string, step: string) => void; onChanged?: () => void;
  /** Its padding: the rail's list lines it up with its own items' (px-3). */
  className?: string;
}) {
  const steps = item.provisional ?? [];
  return (
    <div className={`space-y-2 ${className}`}>
      {steps.length > 1 && <ConfirmAll project={project} steps={steps} onDone={() => onChanged?.()} />}
      <ul className="space-y-2">
        {steps.map((p) => <BatchRow key={`${p.queue}/${p.step}`} project={project} p={p} onOpen={onOpen} onChanged={onChanged} />)}
      </ul>
    </div>
  );
}

const byWord = (by: "user" | "orchestrator" | "helper") => t(by === "user" ? "decisions.by.you" : by === "helper" ? "decisions.by.helper" : "decisions.by.orchestrator");

function BatchRow({ project, p, onOpen, onChanged }: { project: string; p: BatchStep; onOpen: (queue: string, step: string) => void; onChanged?: () => void }) {
  const [preset, setPreset] = useState<{ text: string }>();
  return (
    <li className="rounded-md border border-line bg-canvas/50 px-3 py-2" data-batch-step={`${p.queue}/${p.step}`}>
      <button onClick={() => onOpen(p.queue, p.step)} className="block w-full text-left">
        <span className="font-mono text-xs text-fg-3">{p.queue}/{p.step}</span> <span className="text-sm font-medium text-fg">{p.title}</span>
        {p.text && <span className="mt-0.5 block text-xs text-fg-2"><span className="text-fg-3">{t("provisional.lookAt")} </span>{p.text}</span>}
      </button>
      {p.none && !p.decisions?.length && <p className="mt-1 break-words text-xs text-fg-3">{t("decisions.batch.none")}: “{p.none}”</p>}
      {!!p.decisions?.length && (
        <ul className="mt-1.5" onClick={(e) => e.stopPropagation()}>
          {p.decisions.map((d) => (
            <li key={d.id} className="border-t border-line py-1.5 text-sm" data-batch-decision={d.id}>
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono text-xs text-fg-3">{d.id}</span>
                <span className="min-w-0 flex-1 break-words"><span className="text-fg-2">{d.text}</span> <b className="font-semibold text-fg">{d.choice ?? t("decisions.noneOfThem")}</b></span>
                {d.by !== "user" && (
                  <button type="button" onClick={() => setPreset({ text: insteadText(d) })} aria-label={t("decisions.insteadLabel", { id: d.id })}
                    className="shrink-0 whitespace-nowrap text-xs text-accent hover:underline max-lg:min-h-11">{t("decisions.instead")}</button>
                )}
              </div>
              <p className="break-words text-xs text-fg-3">
                {byWord(d.by)} · <TimeAgo at={d.at} />
                {d.away && ` · ${t("decisions.batch.away")}`}{d.provisional && ` · ${t("decisions.provisional")}`}
                {d.words && <> · “{d.words}”</>}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2"><ProvisionalActions project={project} queue={p.queue} step={p.step} preset={preset} onDone={() => onChanged?.()} /></div>
    </li>
  );
}

/**
 * Confirm all (the user's decision D4): a confirmation listing each step's orchestrator answers to the user's
 * decisions, then one request naming each provisional acceptance shown; if any changed meanwhile nothing is confirmed
 * and the refusal says which (the list then shows what is current).
 */
function ConfirmAll({ project, steps, onDone }: { project: string; steps: BatchStep[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const { reload } = usePage();
  const { busy, error, run } = useAction();
  const confirm = () => void run(
    () => actResult(project, "POST", "/provisional/confirm", { steps: steps.map((p) => ({ queue: p.queue, step: p.step, event: p.event })) }),
    () => { setOpen(false); onDone(); },
  ).finally(reload);
  return (
    <div onClick={(e) => e.stopPropagation()}>
      {!open ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="quiet" onClick={() => setOpen(true)}>{t("decisions.confirmAll", { count: steps.length })}</Button>
          <span className="text-xs text-fg-3">{t("decisions.confirmAllHint")}</span>
        </div>
      ) : (
        <div className="rounded-md border border-review/30 bg-review/5 p-3" role="group" aria-label={t("decisions.confirmAllTitle", { count: steps.length })}>
          <p className="text-sm text-fg">{t("decisions.confirmAllTitle", { count: steps.length })}</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {steps.map((p) => {
              const theirs = (p.decisions ?? []).filter((d) => d.for === "user" && d.by === "orchestrator");
              return (
                <li key={`${p.queue}/${p.step}`} className="break-words">
                  <span className="font-mono text-xs text-fg-3">{p.queue}/{p.step}</span> <span className="text-fg">{p.title}</span>
                  <span className="block text-xs text-fg-2">
                    {theirs.length ? theirs.map((d) => `${d.id}: ${d.choice ?? t("decisions.noneOfThem")}`).join(" · ") : t("decisions.confirmAllNoAnswers")}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={confirm}>{t("decisions.confirmAllButton", { count: steps.length })}</Button>
            <Button variant="quiet" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            {error && <span role="alert" className="text-xs text-danger">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- away mode

const setAway = (until: string | null) => request("/api/server/away", { method: "POST", body: { until } });

/** "Away until 08:00" as a sign (the rail, the phone's header); nothing while away mode is off. */
export function AwaySign({ away, long }: { away?: Away; long?: boolean }) {
  if (!away?.on || !away.until) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-review" title={t("away.hint")}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-review" />
      {t("away.on", { time: formatClock(away.until, new Date()) })}
      {long && <span className="font-normal text-fg-2">· {t("away.short")}</span>}
    </span>
  );
}

/**
 * The away-mode switch: off, "Away…" opens the "until HH:MM" field (08:00 by default: the next such time) and Turn on;
 * on, it says until when, with Turn off. `labelled`: as a settings row's control.
 */
export function AwaySwitch({ away, labelled }: { away?: Away; labelled?: boolean }) {
  const { reloaded } = usePage();
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState("08:00");
  const { busy, error, run } = useAction();
  // In progress until the server's state after the write shows (page.ts, reloaded): the field closes only then, so the
  // switch never shows "off" for a moment after Turn on.
  const go = (until: string | null) => void run(async () => { await setAway(until); await reloaded("/api/server"); }, () => setOpen(false));
  if (away?.on) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <AwaySign away={away} />
        <button onClick={() => go(null)} disabled={busy} className="rounded-md px-2 py-1 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:min-h-11">{t("away.turnOff")}</button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </span>
    );
  }
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} title={t("away.hint")}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-3 hover:text-fg max-lg:min-h-11 ${labelled ? "text-sm" : ""}`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
        {labelled ? t("away.offLabel") : t("away.button")}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1.5 text-fg-2">
        {t("away.until")}
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-md border border-line-strong bg-canvas px-1.5 py-0.5 text-sm text-fg" />
      </label>
      <Button disabled={busy || !time} onClick={() => go(time)}>{t("away.turnOn")}</Button>
      <button onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-fg-3 hover:text-fg">{t("common.cancel")}</button>
      {error && <span className="basis-full text-danger">{error}</span>}
    </span>
  );
}
