// Review levels, provisional acceptances and away mode in the dashboard (PROTOCOL.md, "Review"): the level picker of
// the approval view, a step's level and provisional mark on its line and panel, Confirm and Fix it on a provisional
// acceptance (the return batch and the step), and the away-mode switch with its "until HH:MM" field and its sign.
import { useState } from "react";
import { act, actResult, enc, type AttentionItem, type StepView } from "../api.ts";
import { Button, TEXTAREA } from "./ui.tsx";
import { formatClock, t } from "../i18n.ts";

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
 * A step's review level, to set before approval (or later): 1 · 2 · 3 as one control, the chosen level's words beside
 * it, and "set by you" with Reset when the user set it. Setting a level asks for no new approval.
 */
export function LevelPicker({ project, queue, step, onChanged, away }: {
  project: string; queue: string; step: Pick<StepView, "id" | "level" | "level_from">; onChanged: () => void; away?: Away;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (level: Level | null) => {
    setBusy(true); setError(undefined);
    act(project, "PUT", `/queues/${enc(queue)}/steps/${enc(step.id)}/level`, { level }).then(onChanged, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const mine = step.level_from === "user";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" onClick={(e) => e.stopPropagation()}>
      <span className="text-fg-3">{t("level.label")}</span>
      <span role="radiogroup" aria-label={t("level.pickerLabel", { step: step.id })} className="inline-flex overflow-hidden rounded-md border border-line-strong">
        {LEVELS.map((l) => (
          <button key={l} type="button" role="radio" aria-checked={step.level === l} disabled={busy} title={levelTitle(l)}
            onClick={() => { if (step.level !== l) set(l); }}
            className={`min-w-7 px-2 py-0.5 font-mono max-lg:min-h-9 max-lg:min-w-9 ${l > 1 ? "border-l border-line-strong" : ""} ${step.level === l ? "bg-accent/20 font-semibold text-fg" : "text-fg-3 hover:bg-surface-3 hover:text-fg"}`}>
            {l}
          </button>
        ))}
      </span>
      <span className="text-fg-2" title={levelTitle(step.level)}>{levelShort(step.level)}</span>
      {away?.on && step.level === 2 && <span className="text-review">{t("level.awayAs3")}</span>}
      {mine && <span className="text-accent">{t("level.setByYou")}</span>}
      {mine && <button type="button" onClick={() => set(null)} disabled={busy} className="text-fg-3 underline-offset-2 hover:text-fg hover:underline">{t("level.reset")}</button>}
      {error && <span className="basis-full text-danger">{error}</span>}
    </span>
  );
}

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
export function ProvisionalActions({ project, queue, step, onDone, wide }: { project: string; queue: string; step: string; onDone: () => void; wide?: boolean }) {
  const [fixing, setFixing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = (path: string, body: unknown) => {
    setBusy(true); setError(undefined);
    actResult(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/${path}`, body).then(() => { setFixing(false); setText(""); onDone(); }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
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

/**
 * The return batch's steps, in the "waiting for you" list: each with its queue and step, what the orchestrator said
 * the user should look at, Open, and Confirm or Fix it right there.
 */
export function BatchRows({ project, item, onOpen, onChanged }: {
  project: string; item: AttentionItem; onOpen: (queue: string, step: string) => void; onChanged?: () => void;
}) {
  return (
    <ul className="space-y-2 px-3.5 pb-3">
      {(item.provisional ?? []).map((p) => (
        <li key={`${p.queue}/${p.step}`} className="rounded-md border border-line bg-canvas/50 px-3 py-2">
          <button onClick={() => onOpen(p.queue, p.step)} className="block w-full text-left">
            <span className="font-mono text-xs text-fg-3">{p.queue}/{p.step}</span> <span className="text-sm font-medium text-fg">{p.title}</span>
            {p.text && <span className="mt-0.5 block text-xs text-fg-2"><span className="text-fg-3">{t("provisional.lookAt")} </span>{p.text}</span>}
          </button>
          <div className="mt-2"><ProvisionalActions project={project} queue={p.queue} step={p.step} onDone={() => onChanged?.()} /></div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- away mode

async function setAway(until: string | null): Promise<void> {
  const r = await fetch("/api/server/away", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ until }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
}

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
export function AwaySwitch({ away, onChanged, labelled }: { away?: Away; onChanged: () => void; labelled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState("08:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = (until: string | null) => {
    setBusy(true); setError(undefined);
    setAway(until).then(() => { setOpen(false); onChanged(); }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
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
