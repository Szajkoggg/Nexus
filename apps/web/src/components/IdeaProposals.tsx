// Agents' idea-link proposals in the dashboard (queue IWS, docs/ux/idea-work-signals.md part d): the box in Manage links,
// one group per batch; the proposals on an entry's date card; the waiting card of a batch. Only the user decides, here:
// one request for one item or a whole batch (POST /ideas/proposals), each accepted item checked again by the server.
import { useState } from "react";
import type { IdeaProposalView, IdeaProposalsDecision, IdeaProposalsResponse } from "@nexus/protocol";
import { actResult, projectUrl, request, useAction, type AttentionItem } from "../api.ts";
import { t } from "../i18n.ts";
import { nav } from "../nav.ts";
import { usePage } from "../page.ts";
import { Button, TimeAgo } from "./ui.tsx";

type Op = IdeaProposalView["op"];
const OP_TONE: Record<Op, string> = { add: "text-ok bg-ok/15", remove: "text-danger bg-danger/15", replace: "text-warn bg-warn/15" };
const OP_WORD = { add: "ideas.proposals.op.add", remove: "ideas.proposals.op.remove", replace: "ideas.proposals.op.replace" } as const;

/** An operation's badge: ADD, REMOVE, CHANGE TARGET (`short`: CHANGE, in the waiting card). */
function OpBadge({ op, short }: { op: Op; short?: boolean }) {
  return <span className={`whitespace-nowrap rounded px-1.5 text-[11px] font-bold tracking-wide ${OP_TONE[op]}`}>{t(short && op === "replace" ? "ideas.proposals.op.change" : OP_WORD[op])}</span>;
}

/** Who proposes, as the box's group head and the entry card name them. */
function proposerText(by: IdeaProposalView["by"], queueTitle?: (id: string) => string | undefined): string {
  if (by.role === "orchestrator") return t("ideas.proposals.by.orchestrator");
  if (by.role === "conversation") return by.title ? t("ideas.proposals.by.partnerNamed", { title: by.title }) : t("ideas.proposals.by.partner");
  const title = by.queue ? queueTitle?.(by.queue) : undefined;
  return title ? `${title} ${by.queue}` : t("ideas.proposals.by.worker", { queue: by.queue ?? "" });
}

/**
 * The user's decision on proposals: one request (its revision from a fresh read when none is given, as in a waiting
 * card), then the page's reads again. `message`: the server's answer ("2 accepted; 1 outdated: …").
 */
function useProposalDecision(project: string, onDone?: () => void) {
  const { reloaded } = usePage();
  const { busy, error, run } = useAction();
  const [message, setMessage] = useState<string>();
  const decide = (ids: readonly string[], accept: boolean, revision?: string) => run(async () => {
    const rev = revision ?? (await request<IdeaProposalsResponse>(projectUrl(project, "/ideas/proposals"))).revision;
    const r = await actResult<IdeaProposalsDecision>(project, "POST", "/ideas/proposals", {
      request_id: crypto.randomUUID(), revision: rev, decisions: ids.map((id) => ({ id, accept })),
    });
    setMessage(r?.message);
    await reloaded();
  }, () => onDone?.());
  return { busy, error, message, decide };
}

/** A proposal that may be decided: pending, or outdated and not decided yet (the server marks some at intake). */
export const openProposal = (p: IdeaProposalView) => p.state === "pending" || (p.state === "outdated" && !p.decided?.request);
/** It applies now (an outdated one, or one the links' changes made outdated, is shown greyed with why). */
const applies = (p: IdeaProposalView) => p.state === "pending" && p.valid;
const why = (p: IdeaProposalView) => p.why ?? p.decided?.note ?? "";

/** One proposal: what it does, the queue and the date(s), the proposer's reason, the mapping, Evidence; Accept / Decline. */
function ProposalItem({ p, title, d, revision, head }: {
  p: IdeaProposalView; title?: string; d: ReturnType<typeof useProposalDecision>; revision: string;
  /** Above it, on an entry's card: "Proposed link" and who proposed it when. */
  head?: string;
}) {
  const ok = applies(p);
  return (
    <div className={`grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-1 max-sm:grid-cols-1 ${ok ? "" : "opacity-60"}`} data-proposal={p.id}>
      <div className="flex min-w-0 flex-col gap-0.5 text-[13px] leading-snug">
        {head && <span className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded-md bg-review/15 px-2 py-0.5 font-semibold text-review">{t("ideas.proposals.proposedLink")}</span><span className="text-fg-3">{head} · <TimeAgo at={p.at} /></span></span>}
        <span><OpBadge op={p.op} /> <span className="font-mono text-xs font-semibold text-fg">{p.queue}</span>{title ? ` · ${title}` : ""}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-accent [overflow-wrap:anywhere]">{p.ref}{p.to && <><span className="text-fg-3">→</span>{p.to}</>}</span>
        {ok ? <>
          <span className="text-fg-2">“{p.reason}”</span>
          {p.mapping.map((m) => <span key={m} className="text-xs text-fg-3">{m}</span>)}
          {!!p.evidence?.length && <details className="text-xs text-fg-3"><summary className="cursor-pointer">{t("ideas.proposals.evidence")}</summary><ul className="mt-1 list-disc pl-4">{p.evidence.map((e) => <li key={e}>{e}</li>)}</ul></details>}
        </> : <span className="text-xs text-warn">{t("ideas.proposals.outdated", { why: why(p) })}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {ok ? <>
          <Button variant={head ? "primary" : "quiet"} action="proposal-accept" disabled={d.busy} onClick={() => void d.decide([p.id], true, revision)}>{t("ideas.proposals.accept")}</Button>
          <Button variant="quiet" action="proposal-decline" disabled={d.busy} onClick={() => void d.decide([p.id], false, revision)}>{t("ideas.proposals.decline")}</Button>
        </> : <Button variant="quiet" action="proposal-dismiss" disabled={d.busy} onClick={() => void d.decide([p.id], false, revision)}>{t("ideas.proposals.dismiss")}</Button>}
      </div>
    </div>
  );
}

/** What the decision said, or why it failed. */
function Outcome({ d }: { d: ReturnType<typeof useProposalDecision> }) {
  if (d.error) return <p className="text-sm text-danger" role="alert">{d.error}</p>;
  return d.message ? <p className="text-sm text-ok" role="status">{d.message}</p> : null;
}

/**
 * The proposals in Manage links, above the list in every filter: "Proposed by agents · N", and one group per batch
 * (who, when, how many, the batch's reason, Accept all / Accept the valid one(s) / Decline all), an item a row.
 */
export function ProposalsBox({ project, data, queueTitle }: { project: string; data: IdeaProposalsResponse; queueTitle: (id: string) => string | undefined }) {
  const d = useProposalDecision(project);
  const open = data.proposals.filter(openProposal);
  if (!open.length) return d.message || d.error ? <Outcome d={d} /> : null;
  // The newest batch first, as the waiting list orders its cards.
  const batches = [...new Set(open.map((p) => p.event))].map((event) => open.filter((p) => p.event === event)).sort((a, b) => b[0]!.at.localeCompare(a[0]!.at));
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-review/40 bg-review/[0.04] px-3.5 py-3" data-proposals-box>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold">{t("ideas.proposals.title", { count: open.length })}</span>
        <span className="text-xs text-fg-3">{t("ideas.proposals.note")}</span>
      </div>
      <Outcome d={d} />
      {batches.map((items) => {
        const first = items[0]!;
        const valid = items.filter(applies);
        const stale = items.length - valid.length;
        return (
          <div key={first.event} className="flex flex-col gap-2" data-proposal-batch={first.event}>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <span className="text-sm font-semibold">{proposerText(first.by, queueTitle)}</span>
              <span className="text-xs text-fg-3"><TimeAgo at={first.at} /> · {t("ideas.proposals.count", { count: items.length })}{stale ? `, ${t("ideas.proposals.outdatedCount", { count: stale })}` : ""}</span>
              <span className="flex-1" />
              {valid.length > 0 && <Button action="proposals-accept-all" disabled={d.busy} onClick={() => void d.decide(valid.map((p) => p.id), true, data.revision)}>
                {stale ? t("ideas.proposals.acceptValid", { count: valid.length }) : t("ideas.proposals.acceptAll", { count: valid.length })}</Button>}
              <Button variant="quiet" action="proposals-decline-all" disabled={d.busy} onClick={() => void d.decide(items.map((p) => p.id), false, data.revision)}>{t("ideas.proposals.declineAll")}</Button>
            </div>
            {first.batch_reason && <p className="text-xs text-fg-2">“{first.batch_reason}”</p>}
            {items.map((p) => <div key={p.id} className="border-t border-line pt-2"><ProposalItem p={p} title={queueTitle(p.queue)} d={d} revision={data.revision} /></div>)}
          </div>
        );
      })}
    </section>
  );
}

/** The proposals that touch one dated entry (its ref, or a replacement's target), on the entry's card. */
export function EntryProposals({ project, data, entryRef, queueTitle }: { project: string; data: IdeaProposalsResponse; entryRef: string; queueTitle: (id: string) => string | undefined }) {
  const d = useProposalDecision(project);
  const mine = data.proposals.filter((p) => openProposal(p) && (p.ref === entryRef || p.to === entryRef));
  if (!mine.length) return d.message || d.error ? <Outcome d={d} /> : null;
  return (
    <div className="flex flex-col gap-2">
      {mine.map((p) => <div key={p.id} className="rounded-lg border border-review/45 bg-review/[0.06] px-2.5 py-2">
        <ProposalItem p={p} title={queueTitle(p.queue)} d={d} revision={data.revision} head={t("ideas.proposals.from", { who: proposerText(p.by, queueTitle).replace(/^The /, "the ") })} />
      </div>)}
      <Outcome d={d} />
    </div>
  );
}

const base = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);

/** A batch's waiting card (kind `links`): up to three items a line each, Accept all N, Review… (Manage links), Decline all. */
export function LinkProposalsRow({ project, a, className = "px-3.5 pb-3" }: { project: string; a: AttentionItem; className?: string }) {
  const d = useProposalDecision(project);
  if (!a.links) return null;
  const items = a.links.items;
  const ids = items.map((p) => p.id);
  const review = () => nav.closeThenMatching("waiting", project, "proposed");
  return (
    <div className={className}>
      <ul className="mb-2 flex flex-col gap-0.5 text-xs">
        {items.slice(0, 3).map((p) => <li key={p.id} className="[overflow-wrap:anywhere]"><OpBadge op={p.op} short /> <span className="font-mono font-semibold">{p.queue}</span> {p.op === "remove" ? "✕" : "→"} <span className="font-mono text-fg-2">{base(p.to ?? p.ref)}</span></li>)}
        {items.length > 3 && <li className="text-fg-3">{t("ideas.proposals.more", { count: items.length - 3 })}</li>}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button action="links-accept-all" disabled={d.busy} onClick={() => void d.decide(ids, true)}>{t("ideas.proposals.acceptAll", { count: items.length })}</Button>
        <Button variant="quiet" action="links-review" onClick={review}>{t("ideas.proposals.review")}</Button>
        <Button variant="quiet" action="links-decline-all" disabled={d.busy} onClick={() => void d.decide(ids, false)}>{t("ideas.proposals.declineAll")}</Button>
      </div>
      {d.error && <p className="mt-2 text-sm text-danger" role="alert">{d.error}</p>}
      {d.message && <p className="mt-2 text-sm text-ok" role="status">{d.message}</p>}
    </div>
  );
}
