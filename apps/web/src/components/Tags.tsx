// Step tags in the dashboard (PROTOCOL.md, "Tags"): a step's planned tags beside the activities its worker reported
// doing; the queue card's quiet line of kinds and areas; the project's lists in its settings; and the user's decision
// on the orchestrator's proposals, in the waiting list and in the settings. Only the user accepts a proposal.
import { useState } from "react";
import { NEXUS_ACTIVITIES, TAG_KINDS, TAG_ORIGINS, activityDifference, tagProposalText } from "@nexus/protocol/tags";
import type { TagProposal, TagsFile } from "@nexus/protocol";
import { act, type AttentionItem, type QueueView, type StepView } from "../api.ts";
import { t } from "../i18n.ts";
import { Button, Section } from "./ui.tsx";

const enc = encodeURIComponent;

/** A tag's name as a small chip: `strong` for the kind, `muted` for one planned but not reported, `added` for one done but not planned. */
function Chip({ name, tone = "plain", title }: { name: string; tone?: "strong" | "plain" | "muted" | "added"; title?: string }) {
  const style = {
    strong: "bg-accent/15 text-accent",
    plain: "bg-surface-3 text-fg",
    muted: "bg-surface-2 text-fg-3 line-through decoration-fg-3/60",
    added: "bg-ok/15 text-ok",
  }[tone];
  return <span title={title} className={`inline-block rounded px-1.5 py-px font-mono text-xs ${style}`}>{tone === "added" ? `+ ${name}` : name}</span>;
}

/**
 * The step's tags: kind, size, area and origin as planned, then the planned activities beside those its worker
 * reported at `nexus step done` (planned and not reported struck through, done and not planned marked +).
 */
export function StepTags({ step }: { step: Pick<StepView, "tags" | "observed_activities"> }) {
  const tags = step.tags;
  const diff = activityDifference(tags.activities, step.observed_activities);
  if (!Object.keys(tags).length && !step.observed_activities) return null;
  const facts: [string, string | undefined][] = [
    [t("tags.size"), tags.size], [t("tags.area"), tags.area], [t("tags.origin"), tags.origin],
  ];
  return (
    <Section title={t("tags.title")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-3">
        {tags.kind && <span className="inline-flex items-center gap-1.5">{t("tags.kind")} <Chip name={tags.kind} tone="strong" /></span>}
        {facts.filter(([, v]) => v).map(([label, v]) => <span key={label} className="inline-flex items-center gap-1.5">{label} <Chip name={v!} /></span>)}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-line p-2.5">
        <div className="min-w-0">
          <div className="mb-1.5 text-xs text-fg-3">{t("tags.planned")}</div>
          <div className="flex flex-wrap gap-1.5">
            {(tags.activities ?? []).length === 0 && <span className="text-xs text-fg-3">{t("tags.none")}</span>}
            {(tags.activities ?? []).map((a) => diff?.skipped.includes(a)
              ? <Chip key={a} name={a} tone="muted" title={t("tags.skippedTitle")} />
              : <Chip key={a} name={a} />)}
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 text-xs text-fg-3">{t("tags.done")}</div>
          <div className="flex flex-wrap gap-1.5">
            {!diff && <span className="text-xs text-fg-3">{t("tags.notReported")}</span>}
            {diff?.both.map((a) => <Chip key={a} name={a} />)}
            {diff?.unplanned.map((a) => <Chip key={a} name={a} tone="added" title={t("tags.unplannedTitle")} />)}
          </div>
        </div>
      </div>
    </Section>
  );
}

/** The kinds and areas of a queue's own steps, in their order, each once: the queue card's quiet line. */
function queueTagWords(queue: Pick<QueueView, "steps">): string[] {
  const own = queue.steps.filter((s) => !s.closing && !s.integration);
  const kinds = own.map((s) => s.tags.kind).filter((x): x is string => !!x);
  const areas = own.map((s) => s.tags.area).filter((x): x is string => !!x);
  return [...new Set(kinds), ...new Set(areas)];
}

/** The quiet line of a queue's kinds and areas on its card; nothing for a queue without tags. */
export function QueueTags({ queue }: { queue: Pick<QueueView, "steps"> }) {
  const words = queueTagWords(queue);
  if (!words.length) return null;
  return <span className="truncate font-mono text-xs text-fg-3" title={t("tags.queueTitle")}>{words.join(" · ")}</span>;
}

/** The user's decision on a tag proposal: accept or decline, with the server's refusal shown. */
function useDecision(project: string, onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = async (id: string, action: "accept" | "decline") => {
    setBusy(true); setError(undefined);
    try { await act(project, "POST", `/tags/${enc(id)}`, { action }); onChanged?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return { busy, error, decide };
}

function DecisionButtons({ id, d }: { id: string; d: ReturnType<typeof useDecision> }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => void d.decide(id, "accept")} disabled={d.busy}>{t("tags.accept")}</Button>
      <Button variant="quiet" onClick={() => void d.decide(id, "decline")} disabled={d.busy}>{t("tags.decline")}</Button>
    </div>
  );
}

/** A tag proposal's buttons in a waiting card (kind `tags`). */
export function TagProposalRow({ project, a, onChanged, className = "px-3.5 pb-3" }: { project: string; a: AttentionItem; onChanged?: () => void; className?: string }) {
  const d = useDecision(project, onChanged);
  if (!a.tags) return null;
  return (
    <div className={className}>
      <DecisionButtons id={a.tags.id} d={d} />
      {d.error && <p className="mt-2 text-sm text-danger" role="alert">{d.error}</p>}
    </div>
  );
}

function ProposalLine({ project, p, list, onChanged }: { project: string; p: TagProposal; list: TagsFile; onChanged?: () => void }) {
  const d = useDecision(project, onChanged);
  return (
    <li className="rounded-lg border border-line p-2.5">
      <div className="text-sm text-fg">{tagProposalText(p, list)}</div>
      {p.reason && <div className="mt-0.5 text-xs text-fg-2">{p.reason}</div>}
      <div className="mt-2"><DecisionButtons id={p.id} d={d} /></div>
      {d.error && <p className="mt-2 text-sm text-danger" role="alert">{d.error}</p>}
    </li>
  );
}

/** One list of names as chips, or "none yet". */
function Names({ names }: { names: readonly string[] }) {
  return names.length
    ? <div className="flex flex-wrap gap-1.5">{names.map((n) => <Chip key={n} name={n} />)}</div>
    : <span className="text-sm text-fg-3">{t("tags.noneYet")}</span>;
}

/**
 * The project's tag lists in its settings: its areas and own activities (with the prefix), the renames, the
 * proposals waiting for the user (accepted or declined here too), and Nexus's own lists for reference.
 */
export function ProjectTags({ project, tags, onChanged }: { project: string; tags: TagsFile; onChanged?: () => void }) {
  const [nexus, setNexus] = useState(false);
  return (
    <Section title={t("tags.projectTitle")}>
      <p className="text-xs text-fg-3">{t("tags.projectNote")}</p>
      {tags.proposals.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-xs font-medium text-warn">{t("tags.waiting", { count: tags.proposals.length })}</div>
          <ul className="space-y-2">{tags.proposals.map((p) => <ProposalLine key={p.id} project={project} p={p} list={tags} onChanged={onChanged} />)}</ul>
        </div>
      )}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-fg-2">{t("tags.areas")}</dt>
        <dd><Names names={tags.areas.map((x) => x.name)} /></dd>
        <dt className="text-fg-2">{t("tags.ownActivities")}{tags.prefix && <span className="ml-1 text-xs text-fg-3">{t("tags.prefix", { prefix: tags.prefix })}</span>}</dt>
        <dd><Names names={tags.activities.map((x) => x.name)} /></dd>
        {tags.renames.length > 0 && <>
          <dt className="text-fg-2">{t("tags.renamed")}</dt>
          <dd className="space-y-1">{tags.renames.map((r) => (
            <div key={`${r.from}>${r.to}`} className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3"><Chip name={r.from} tone="muted" />→<Chip name={r.to} /></div>
          ))}</dd>
        </>}
      </dl>
      <button onClick={() => setNexus(!nexus)} aria-expanded={nexus} className="mt-3 text-xs text-accent hover:underline">{t(nexus ? "tags.nexusHide" : "tags.nexusShow")}</button>
      {nexus && (
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-fg-2">{t("tags.kinds")}</dt><dd><Names names={TAG_KINDS} /></dd>
          <dt className="text-fg-2">{t("tags.activities")}</dt><dd><Names names={NEXUS_ACTIVITIES} /></dd>
          <dt className="text-fg-2">{t("tags.origins")}</dt><dd><Names names={TAG_ORIGINS} /></dd>
        </dl>
      )}
    </Section>
  );
}
