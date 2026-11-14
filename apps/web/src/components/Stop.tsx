// A stopped queue's way on, wherever the stop is shown (UX proposals, quick fix 4): the stopped step's line in the
// queue card, the waiting cards, and the queue's own drawer and bar. One read of what the stopped step left (useLeft),
// one Continue (useContinue), and the buttons and hints from one decision (stopDecision.ts). Continue lifts the stop at
// once when there is nothing to decide; when the stopped step left commits of its own, "Continue…" opens SC2's Keep or
// Discard first, in place. A queue whose revision is not approved has "Approve revision N…", which opens the queue.
import { useEffect, useId, useState, type ReactNode } from "react";
import { actResult, enc } from "../api.ts";
import { stopDecision, type LeftState, type LeftView, type WorkChoice } from "../stopDecision.ts";
import { stopPlace } from "@nexus/protocol/attention";
import type { QueueView } from "../api.ts";
import { Expandable, TimeAgo } from "./ui.tsx";
import { rich, t } from "../i18n.ts";

/**
 * What the stopped step left: its own commits, with Keep or Discard when there are any, and the checkout's uncommitted
 * changes, which are not necessarily the step's and are never cleaned. `pushAccepted` unknown (a waiting card of
 * another project): Keep says only that the commits stay.
 */
export function StoppedWork({ left, work, setWork, needsChoice, pushAccepted, branch }: {
  left: LeftView; work?: WorkChoice; setWork: (w: WorkChoice) => void; needsChoice: boolean; pushAccepted?: boolean; branch?: string;
}) {
  const name = useId();
  if (!left.commits.length && !left.uncommitted.length) return <p className="mt-3 text-xs text-fg-2">{t("stop.leftNothing", { step: left.step })}</p>;
  const n = left.commits.length;
  const option = (value: WorkChoice, title: string, text: string) => (
    <label className={`flex cursor-pointer gap-2 rounded-md p-2 ring-1 ${work === value ? "bg-surface ring-accent/60" : "ring-line-strong hover:bg-surface/60"}`}>
      <input type="radio" name={name} checked={work === value} onChange={() => setWork(value)} className="mt-1 accent-accent" />
      <span><span className="font-medium text-fg">{title}</span><span className="block text-xs text-fg-2">{text}</span></span>
    </label>
  );
  return (
    <div className="mt-3 space-y-3 rounded-md bg-surface/70 p-2.5">
      {n > 0 && (
        <div>
          <p className="text-xs text-fg-2">{t("stop.leftCommits", { step: left.step, count: n })}</p>
          <ul className="mt-1 space-y-1">
            {left.commits.map((c) => (
              <li key={c.sha} className="text-sm">
                <span className="font-mono text-xs text-fg-3">{c.sha.slice(0, 7)}</span> <span className="text-fg">{c.subject}</span>
                <span className="block pl-[3.6rem] text-[11px] text-fg-3">{t("stop.files", { count: c.files })} · <span className="text-ok/80">+{c.insertions}</span> <span className="text-danger/80">−{c.deletions}</span> · <TimeAgo at={c.at} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {left.uncommitted.length > 0 && (
        <div>
          <p className="text-xs text-fg-2">{t("stop.uncommitted", { note: left.uncommitted_note })}</p>
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-fg">
            {left.uncommitted.map((u) => <li key={u.path} className="break-all"><span className="inline-block w-6 text-warn/90">{u.status}</span>{u.path}</li>)}
          </ul>
        </div>
      )}
      {left.discarded && <p className="text-sm text-fg">{rich("stop.discardedAt", { time: <TimeAgo key="time" at={left.discarded.at} /> })}</p>}
      {needsChoice && (
        <div className="space-y-1.5" role="radiogroup" aria-label={t("stop.commitsLabel")}>
          {option("keep", t("stop.keep"), pushAccepted === undefined
            ? (branch ? t("stop.keep.staysIn", { branch }) : t("stop.keep.stays"))
            : pushAccepted
              ? (branch ? t("stop.keep.pushedTo", { branch }) : t("stop.keep.pushed"))
              : (branch ? t("stop.keep.localIn", { branch }) : t("stop.keep.local")))}
          {option("discard", t("stop.discard"), t("stop.discard.text"))}
        </div>
      )}
    </div>
  );
}

/**
 * A stopped queue's stop: why and where, the orchestrator's proposal, what the step left; Continue is in the
 * bar. Continue (the user's lift) only when the current revision is approved; otherwise approving it lifts the stop.
 */
/**
 * A stop's reason, short, with its condition behind "more" (queue QR): the step's line, the stop box, the step's
 * drawer and the waiting card. A stop known only as one text (no condition apart) shows that text as it was.
 * `clamp` keeps the reason to a few lines (the step's line, a card); clicks inside stay here.
 */
export function StopReason({ reason, condition, className = "", clamp }: { reason: string; condition?: string; className?: string; clamp?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`block ${className}`}>
      <span className={clamp && !open ? "line-clamp-2" : ""}>{plainText(reason)}</span>
      {condition && (
        <>
          {" "}
          <button onClick={(e) => { e.stopPropagation(); setOpen(!open); }} onKeyDown={(e) => e.stopPropagation()} aria-expanded={open}
            className="whitespace-nowrap text-xs text-accent hover:underline max-lg:min-h-8">{t(open ? "stop.less" : "stop.more")}</button>
          {open && <span className="mt-1 block text-fg-2"><span className="text-fg-3">{t("stop.condition")} </span>{plainText(condition)}</span>}
        </>
      )}
    </span>
  );
}
const plainText = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "");

/** A stopped queue's reason, as StopReason shows it: the stop's own fields, else its one text. */
export function QueueStopReason({ queue, className, clamp }: { queue: QueueView; className?: string; clamp?: boolean }) {
  if (queue.stop) return <StopReason reason={queue.stop.reason} condition={queue.stop.condition} className={className} clamp={clamp} />;
  return queue.status_reason ? <StopReason reason={queue.status_reason} className={className} clamp={clamp} /> : null;
}

export function StopBox({ queue, left, work, setWork, needsChoice, pushAccepted }: {
  queue: QueueView; left?: LeftView; work?: WorkChoice; setWork: (w: WorkChoice) => void; needsChoice: boolean; pushAccepted: boolean;
}) {
  const p = queue.lift_proposal;
  return (
    <div className="mt-4 rounded-lg border border-stop/30 bg-stop/10 p-3 text-sm">
      <p className="font-medium text-stop">{t("stop.stopped", { place: stopPlace(queue) })}</p>
      {queue.stop ? <QueueStopReason queue={queue} className="mt-1 text-fg" /> : queue.status_reason && <div className="mt-1 text-fg"><Expandable text={queue.status_reason} /></div>}
      {p && (
        <div className="mt-3 rounded-md bg-surface/70 p-2.5">
          <p className="text-xs text-fg-3">{t("waiting.liftProposal")} · <TimeAgo at={p.at} /></p>
          <p className="mt-0.5 text-fg">{p.reason}</p>
        </div>
      )}
      {left && <StoppedWork left={left} work={work} setWork={setWork} needsChoice={needsChoice} pushAccepted={pushAccepted} branch={queue.branch} />}
      {!queue.approved && (
        <p className="mt-3 text-xs text-fg-2">{t(needsChoice ? "stop.notApprovedChoice" : "stop.notApproved", { revision: queue.revision })}</p>
      )}
    </div>
  );
}

/** A stopped queue's version for what its step left: its times, which a Keep, a Discard or a lift changes. */
export const stopVersion = (q: { updated?: string; updated_at?: string }) => `${q.updated ?? ""}/${q.updated_at ?? ""}`;

/** The look of the small buttons beside a stop (the step list's and the waiting cards'). */
export const STOP_BUTTON = "shrink-0 rounded-md border border-line-strong bg-surface-2 px-3 py-1 text-sm font-medium text-fg hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40 max-lg:min-h-11";
export const OPEN_BUTTON = "shrink-0 rounded-md px-3 py-1 text-sm font-medium text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:min-h-11";

type Left = Exclude<LeftState, undefined>;

/**
 * What stopped steps left, the one source for every place that shows a stop (the queue's drawer, the step's line, the
 * waiting cards): one request per queue and version (the server asks git, which takes a while on Windows), the last
 * answer shown at once while a newer one is read, and every place told when it arrives.
 */
const lefts = new Map<string, { version?: string; value?: Left; reading?: Promise<void>; subs: Set<(v: Left) => void> }>();

function readLeft(project: string, queue: string, version: string, force = false) {
  const key = `${project}/${queue}`;
  const e = lefts.get(key) ?? { subs: new Set() };
  lefts.set(key, e);
  if (!force && e.version === version && (e.reading || e.value !== undefined)) return e;
  e.version = version;
  const reading: Promise<void> = fetch(`/api/projects/${enc(project)}/queues/${enc(queue)}/left`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
    .then((d: LeftView | null) => d, (): Left => "error")
    .then((v) => {
      if (e.reading !== reading) return; // a newer read is under way
      e.value = v; e.reading = undefined;
      for (const f of e.subs) f(v);
    });
  e.reading = reading;
  return e;
}

/** What the stopped step left, read when `enabled`: undefined while first read, null outside git, "error" when unreadable. */
export function useLeft(project: string, queue: string, enabled: boolean, version: string): LeftState {
  const [left, setLeft] = useState<LeftState>(() => (enabled ? lefts.get(`${project}/${queue}`)?.value : undefined));
  useEffect(() => {
    if (!enabled) { setLeft(undefined); return; }
    const e = readLeft(project, queue, version);
    setLeft(e.value);
    e.subs.add(setLeft);
    return () => { e.subs.delete(setLeft); };
  }, [project, queue, enabled, version]);
  return left;
}

/**
 * Continue on a stopped queue, the one implementation: the user's lift, with their Keep or Discard when the stopped
 * step left commits; what the server said back (Discard: the orchestrator drafts a revert) or why it refused. Every
 * place showing the stop then reads what the step left anew.
 */
export function useContinue({ project, queue, onChanged }: { project: string; queue: string; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const go = async (needsChoice: boolean, work?: WorkChoice): Promise<boolean> => {
    setBusy(true); setError(undefined); setNote(undefined);
    try {
      const r = await actResult<{ message?: string } | string>(project, "POST", `/queues/${enc(queue)}/continue`, needsChoice ? { work } : {});
      if (r && typeof r === "object" && r.message) setNote(r.message);
      const e = lefts.get(`${project}/${queue}`);
      if (e) readLeft(project, queue, e.version ?? "", true);
      onChanged?.();
      return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  return { go, busy, error, note, setNote };
}

/**
 * A stopped queue's actions where its stop is shown in short: `buttons` (Continue, "Continue…" or "Approve revision
 * N…") for the caller's row, and `panel` (Keep or Discard once "Continue…" is open, what the server said, an error)
 * for below it. Clicks and keys inside stay there: the step's line around them opens the step.
 */
export function useStopActions({ project, queue, approved, revision, version, onOpen, onChanged, pushAccepted, branch, discardShownElsewhere }: {
  project: string; queue: string; approved: boolean; revision: number;
  /** What the step left is read again when it changes (stopVersion of the queue, or the waiting item's time). */
  version: string | undefined;
  /** Opens the queue: its stop box and its approval. */
  onOpen: () => void;
  onChanged?: () => void; pushAccepted?: boolean; branch?: string;
  /** The stop's line on the same page says that Discard was chosen: this place does not repeat it. */
  discardShownElsewhere?: boolean;
}): { buttons?: ReactNode; panel?: ReactNode } {
  const left = useLeft(project, queue, approved, String(version));
  const known = left === "error" ? undefined : left;
  const [choosing, setChoosing] = useState(false);
  const [work, setWork] = useState<WorkChoice>();
  const cont = useContinue({ project, queue, onChanged });
  const d = stopDecision({ approved, revision, left, work });
  const stay = { onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(), onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation() };
  const go = async () => { if (await cont.go(d.needsChoice, work)) setChoosing(false); };

  const message = (cont.error || cont.note) && <p className={`mt-1.5 text-xs ${cont.error ? "text-danger" : "text-info"}`}>{cont.error ?? cont.note}</p>;
  const shownHint = d.discarded && !discardShownElsewhere && d.hint;
  const opener = d.opener && (
    <button {...stay} disabled={d.opener.disabled || cont.busy} title={d.opener.title} aria-expanded={d.opener.action === "choose" ? choosing : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (d.opener!.action === "open") onOpen();
        else if (d.opener!.action === "choose") setChoosing(!choosing);
        else void go();
      }}
      className={STOP_BUTTON}>
      {cont.busy && !choosing ? t("stop.continuing") : d.opener.label}
    </button>
  );
  const panel = (choosing && known && d.confirm) || message || shownHint ? (
    <div {...stay} className="cursor-auto">
      {shownHint && <p className="mt-1.5 text-xs text-fg-2">{shownHint}</p>}
      {choosing && known && d.confirm && (
        <div className="rounded-md border border-line bg-surface-2 p-2.5 [&>div:first-child]:mt-0">
          <StoppedWork left={known} work={work} setWork={setWork} needsChoice={d.needsChoice} pushAccepted={pushAccepted} branch={branch} />
          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto min-w-[8rem] flex-1 text-xs text-fg-3">{d.hint}</span>
            <button onClick={() => { setChoosing(false); setWork(undefined); }} className={OPEN_BUTTON}>{t("common.cancel")}</button>
            <button disabled={cont.busy || d.confirm.disabled} onClick={() => void go()}
              className="rounded-md bg-accent-strong px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 max-lg:min-h-11 max-lg:px-4">
              {cont.busy ? t("ui.sending") : d.confirm.label}
            </button>
          </div>
        </div>
      )}
      {message}
    </div>
  ) : undefined;
  return { buttons: opener, panel };
}

/** useStopActions as a component, for a caller that has a stop only sometimes: `children` places the two parts. */
export function StopActions({ children, ...props }: Parameters<typeof useStopActions>[0] & { children: (a: ReturnType<typeof useStopActions>) => ReactNode }) {
  return <>{children(useStopActions(props))}</>;
}
