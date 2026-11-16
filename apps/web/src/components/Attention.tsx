import { useState } from "react";
import type { AttentionItem, ProjectSummary, QueueView } from "../api.ts";
import { attentionKey, mergeAttention, type WaitingItem } from "@nexus/protocol/attention";
import { TimeAgo } from "./ui.tsx";
import { t, type Key } from "../i18n.ts";
import { OPEN_BUTTON, stopVersion, useStopActions } from "./Stop.tsx";
import { stepThatMatters } from "./QueueRow.tsx";
import { BatchRows } from "./Levels.tsx";
import { nav } from "../nav.ts";
import { PlanRow } from "./Plan.tsx";
import { TagProposalRow } from "./Tags.tsx";
import { RecurringRow } from "./Recurring.tsx";

const KIND: Record<AttentionItem["kind"], { key: Key; tone: string }> = {
  question: { key: "waiting.kind.question", tone: "text-warn bg-warn/15" },
  stopped: { key: "waiting.kind.stopped", tone: "text-stop bg-stop/15" },
  approval: { key: "waiting.kind.approval", tone: "text-info bg-info/15" },
  review: { key: "waiting.kind.review", tone: "text-review bg-review/15" },
  failed: { key: "waiting.kind.failed", tone: "text-danger bg-danger/15" },
  start: { key: "waiting.kind.start", tone: "text-stop bg-stop/15" },
  provisional: { key: "waiting.kind.provisional", tone: "text-review bg-review/15" },
  plan: { key: "waiting.kind.plan", tone: "text-warn bg-warn/15" },
  merge: { key: "waiting.kind.merge", tone: "text-warn bg-warn/15" },
  tags: { key: "waiting.kind.tags", tone: "text-info bg-info/15" },
  recurring: { key: "waiting.kind.recurring", tone: "text-info bg-info/15" },
  cleanup: { key: "waiting.kind.cleanup", tone: "text-warn bg-warn/15" },
};
/** An item's kind in a word and its colour, in the interface language. */
/** A waiting item's kind as a word, with its colour. */
export const kindLabel = (kind: AttentionItem["kind"]) => ({ text: t(KIND[kind].key), tone: KIND[kind].tone });

const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "");
/** An item's text: the return batch's in the interface language, the others as the server words them. */
/** A waiting item's text, plain (no Markdown links or emphasis). */
export const textOf = (a: AttentionItem) => (a.kind === "provisional" ? t("waiting.batchText", { count: a.provisional?.length ?? 0 }) : plain(a.text));

/** Where an item leads: a stopped queue's item opens the queue, whose stop box has what the step left; others their step. */
export const attentionTarget = (a: AttentionItem): string | undefined => (a.lift ? undefined : a.step);

/** The queue and step an item is about; for a stopped queue, where its stop is ("W at step W4b", "W (the stop came …)"). */
const whereOf = (a: AttentionItem) => (a.lift ? `${a.queue}${a.lift.place}` : `${a.queue ?? ""}${a.step ? `/${a.step}` : ""}`);

/** The orchestrator's proposal to lift a stop, with its reason and time, in a stopped queue's waiting card. */
function LiftProposal({ lift }: { lift: NonNullable<AttentionItem["lift"]> }) {
  if (!lift.proposal) return null;
  return (
    <span className="mt-1.5 block rounded-md bg-canvas/60 px-2 py-1 text-xs text-fg">
      <span className="text-fg-3">{t("waiting.liftProposal")} · <TimeAgo at={lift.proposal.at} /></span>
      <span className="line-clamp-2 block">{plain(lift.proposal.reason)}</span>
    </span>
  );
}

/**
 * A stopped queue's way on, in its waiting card: Continue right there (Keep or Discard first when the stopped step
 * left commits; Stop.tsx), or "Approve revision N…" when its revision is not approved, and Open.
 */
function StopRow({ project, a, onOpen, onChanged, pushAccepted, queue }: {
  project: string; a: AttentionItem & { lift: NonNullable<AttentionItem["lift"]> }; onOpen: () => void; onChanged?: () => void;
  pushAccepted?: boolean;
  /** The queue, on its project's page: its branch, and the version its step line uses too. */
  queue?: QueueView;
}) {
  const { buttons, panel } = useStopActions({
    project, queue: a.queue!, approved: a.lift.continue, revision: a.lift.revision, version: queue ? stopVersion(queue) : a.at,
    onOpen, onChanged, pushAccepted, branch: queue?.branch, discardShownElsewhere: !!queue && !!stepThatMatters(queue),
  });
  // The card shows the stop's short reason; its condition opens under "more" (not where the step's line below has it).
  const [more, setMore] = useState(false);
  const condition = !(queue && stepThatMatters(queue)) ? a.condition : undefined;
  return (
    <div className="px-3.5 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        {buttons}
        <button onClick={onOpen} className={OPEN_BUTTON}>{t("common.open")}</button>
        {condition && (
          <button onClick={() => setMore(!more)} aria-expanded={more} className={`${OPEN_BUTTON} ml-auto text-accent`}>{t(more ? "stop.less" : "stop.more")}</button>
        )}
      </div>
      {condition && more && <p className="mt-2 text-sm text-fg-2"><span className="text-fg-3">{t("stop.condition")} </span>{plain(condition)}</p>}
      {panel && <div className="mt-2">{panel}</div>}
    </div>
  );
}

/**
 * What waits for the user in this project, on its page. A stopped queue's card names the queue and has Continue; its
 * reason is shown once, at the stopped step in the queue's card below (only when that card shows no stopped step,
 * here). `queues` gives the titles and that.
 */
export function AttentionPanel({ project, items, queues, pushAccepted, onOpen, onChanged }: {
  project: string; items: AttentionItem[]; queues: QueueView[]; pushAccepted: boolean;
  onOpen: (a: AttentionItem) => void; onChanged?: () => void;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-warn/90">
        {t("waiting.title")} <span className="ml-1 text-xs text-fg-3">{items.length}</span>
      </h2>
      <div className="grid items-start gap-2 @2xl:grid-cols-2">
        {items.map((a) => {
          const q = a.lift ? queues.find((x) => x.id === a.queue) : undefined;
          const reasonBelow = !!q && !!stepThatMatters(q);
          return (
            <div key={attentionKey(a)} className="rounded-lg border border-line bg-surface hover:border-fg-3/60">
              <button onClick={() => onOpen(a)} className="flex w-full items-start gap-3 p-3 text-left">
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${kindLabel(a.kind).tone}`}>{kindLabel(a.kind).text}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs text-fg-3">{whereOf(a)}</span>
                  <span className="line-clamp-2 text-sm text-fg">{reasonBelow ? q!.title : textOf(a)}</span>
                  {a.lift && <LiftProposal lift={a.lift} />}
                </span>
                {a.at && <span className="shrink-0 text-xs text-fg-3"><TimeAgo at={a.at} /></span>}
              </button>
              {a.lift && a.queue && (
                <StopRow project={project} a={{ ...a, lift: a.lift }} onOpen={() => onOpen(a)} onChanged={onChanged} pushAccepted={pushAccepted} queue={q} />
              )}
              {a.kind === "provisional" && <BatchRows project={project} item={a} onOpen={(queue, step) => nav.item(project, queue, step)} onChanged={onChanged} />}
              {a.kind === "plan" && <PlanRow project={project} a={a} onChanged={onChanged} />}
              {a.kind === "tags" && <TagProposalRow project={project} a={a} onChanged={onChanged} />}
              {a.kind === "recurring" && <RecurringRow project={project} a={a} onChanged={onChanged} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- across all projects

/**
 * Everything waiting for the user in every project, newest first; a tap opens the item in its project. Each card puts
 * the kind, where it is and when on one line and gives the text the full width; a question's options are buttons
 * that open its sheet with that option chosen, for the user to confirm there (`onChoose`).
 */
export function WaitingList({ projects, onOpen, onChoose }: {
  projects: ProjectSummary[]; onOpen: (w: WaitingItem) => void; onChoose?: (w: WaitingItem, option: string) => void;
}) {
  const items = mergeAttention(projects);
  return (
    <div>
      <div className="flex items-baseline gap-3 pr-10 lg:pr-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-warn">{t("waiting.titleCount", { count: items.length })}</h2>
        <span className="ml-auto text-xs text-fg-3">{t("waiting.newestFirst")}</span>
      </div>
      {items.length === 0 && <p className="mt-6 text-sm text-fg-2">{t("waiting.nothing")}</p>}
      <ul className="mt-3 space-y-2.5">
        {items.map((a) => (
          <li key={`${a.project}/${attentionKey(a)}`} className="rounded-lg border border-line bg-surface hover:border-fg-3/60">
            <button onClick={() => onOpen(a)} className="block w-full px-3.5 pb-3 pt-3 text-left">
              <span className="flex min-w-0 items-center gap-2 text-xs">
                <span className={`shrink-0 rounded-md px-2 py-0.5 font-semibold ${kindLabel(a.kind).tone}`}>{kindLabel(a.kind).text}</span>
                <span className="min-w-0 flex-1 truncate text-fg-3">{a.project_name}{a.queue && <> · <span className="font-mono">{whereOf(a)}</span></>}</span>
                {a.at && <span className="shrink-0 text-fg-3"><TimeAgo at={a.at} /></span>}
              </span>
              <span className="mt-1.5 line-clamp-3 text-[15px] leading-snug text-fg">{textOf(a)}</span>
              {a.lift && <LiftProposal lift={a.lift} />}
            </button>
            {a.lift && a.queue && <StopRow project={a.project} a={{ ...a, lift: a.lift }} onOpen={() => onOpen(a)} />}
            {a.kind === "provisional" && <BatchRows project={a.project} item={a} onOpen={(queue, step) => nav.item(a.project, queue, step)} />}
            {a.kind === "plan" && <PlanRow project={a.project} a={a} />}
            {a.kind === "tags" && <TagProposalRow project={a.project} a={a} />}
            {a.kind === "recurring" && <RecurringRow project={a.project} a={a} />}
            {onChoose && a.kind === "question" && !!a.options?.length && (
              <div className="flex flex-wrap gap-2 px-3.5 pb-3">
                {a.options.map((o, i) => (
                  <button key={o} onClick={() => onChoose(a, o)} title={t("waiting.chooseTitle")}
                    className="min-h-11 min-w-[40%] flex-1 rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm font-medium text-fg hover:bg-surface-3">
                    {i + 1} · {o}
                    {a.recommended === o && <span className="ml-1.5 text-accent" aria-label={t("waiting.recommended")} title={t("waiting.recommended")}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What waits in every project, as the desktop's rail shows it (mockup 11A): one card, an item a row with its kind,
 * where it is (with its project when it is not the current one) and when, the text in two lines; a stopped queue has
 * Continue and Open. A tap opens the item in its project.
 */
export function WaitingCards({ projects, current, onOpen }: { projects: ProjectSummary[]; current?: string; onOpen: (w: WaitingItem) => void }) {
  const items = mergeAttention(projects);
  if (!items.length) return <p className="px-1 text-sm text-fg-3">{t("waiting.nothing")}</p>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2">
      {items.map((a) => (
        <li key={`${a.project}/${attentionKey(a)}`}>
          <button onClick={() => onOpen(a)} className="block w-full px-3 pb-2.5 pt-2.5 text-left hover:bg-surface-3/50">
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className={`shrink-0 rounded px-1.5 py-px font-semibold ${kindLabel(a.kind).tone}`}>{kindLabel(a.kind).text}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-fg-3">{a.project !== current && <span className="font-sans">{a.project_name} · </span>}{whereOf(a)}</span>
              {a.at && <span className="shrink-0 text-fg-3"><TimeAgo at={a.at} /></span>}
            </span>
            <span className="mt-1 line-clamp-2 text-sm leading-snug text-fg">{textOf(a)}</span>
            {a.lift && <LiftProposal lift={a.lift} />}
          </button>
          {a.lift && a.queue && <div className="-mt-1"><StopRow project={a.project} a={{ ...a, lift: a.lift }} onOpen={() => onOpen(a)} /></div>}
          {a.kind === "provisional" && <div className="-mx-0.5"><BatchRows project={a.project} item={a} onOpen={(queue, step) => nav.item(a.project, queue, step)} /></div>}
          {a.kind === "plan" && <div className="-mx-3.5 -mb-3"><PlanRow project={a.project} a={a} /></div>}
          {a.kind === "tags" && <TagProposalRow project={a.project} a={a} className="px-3 pb-2.5" />}
          {a.kind === "recurring" && <RecurringRow project={a.project} a={a} className="px-3 pb-2.5" />}
        </li>
      ))}
    </ul>
  );
}
