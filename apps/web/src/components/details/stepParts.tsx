// The parts of a step's panel, each drawn from the step (StepDetail.tsx puts them in order: one order while the step
// waits for the user's review, another otherwise).
import { useState } from "react";
import { latestChecks, stepChecks, type CheckView } from "@nexus/protocol/steps";
import { act, enc, fileUrl, useQuery, type QueueView, type SessionView, type StepView } from "../../api.ts";
import { describe, isImage, type stepPictures } from "../../details.ts";
import { draftKey } from "../../drafts.ts";
import { fileHref } from "../../hash.ts";
import { formatClock, formatSeconds, rich, t } from "../../i18n.ts";
import { nav } from "../../nav.ts";
import { reviewedByOrchestrator } from "@nexus/protocol/status-rules";
import { pendingProvisional, ProvisionalActions } from "../Levels.tsx";
import { RetryNote } from "../Run.tsx";
import { StopReason } from "../Stop.tsx";
import { StepTags } from "../Tags.tsx";
import { Composer, Expandable, Markdown, Section, TimeAgo } from "../ui.tsx";
import { StepCommits } from "./git.tsx";
import { Fold, PictureBadges } from "./review.tsx";
import { usePage } from "../../page.ts";
import { metricValueText } from "@nexus/protocol/metrics";
import { latestCheckSet } from "@nexus/protocol/checks";
import { stepMetrics } from "../../metrics.ts";
import { checkRows, queuedText, type CheckRowState } from "../../checks.ts";
import { capacityWait } from "@nexus/protocol/capacity";
import type { CapacityFile } from "@nexus/protocol";

type Pairs = ReturnType<typeof stepPictures>["pairs"];
interface StepProps { step: StepView }
interface InQueue extends StepProps { queue: QueueView }
interface Writes extends InQueue { project: string }

/** A retry the run waits for on this step. */
export function RetryLine({ queue, step }: InQueue) {
  if (queue.run?.state !== "retry_wait" || queue.run.step !== step.id) return null;
  return (
    <div className="mt-4 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm">
      <RetryNote run={queue.run} className="text-sm" />
      {queue.run.reason && <p className="mt-1 text-xs text-fg-2">{queue.run.reason}</p>}
    </div>
  );
}

const ROW: Record<CheckRowState, { mark: string; tone: string }> = {
  passed: { mark: "✓", tone: "text-ok" }, flaky: { mark: "✓", tone: "text-warn" }, failed: { mark: "✗", tone: "text-danger" },
  running: { mark: "●", tone: "text-accent" }, waiting: { mark: "○", tone: "text-fg-3" }, interrupted: { mark: "–", tone: "text-fg-3" },
  notCommand: { mark: "–", tone: "text-warn" },
};

/** A reported check outcome's mark and tone, as the rows of a check set show them. */
const checkMark = (c: CheckView) => ROW[c.not_command ? "notCommand" : c.ok ? "passed" : "failed"];

/**
 * The checks Nexus runs after the step's done (docs/PROTOCOL.md, "Checks run by Nexus"), while they decide the step:
 * waiting for the machine, running, on the queue's base commit, a dispute for the orchestrator, or a check-fix round
 * (said apart from the review rounds: a fix round is no send-back), with the latest set's checks one by one.
 */
export function CheckRunBox({ project, queue, step }: InQueue & { project: string }) {
  const set = latestCheckSet(queue, step);
  const c = step.checking;
  // While they wait for the machine: what they wait behind, from the capacity coordinator's file (queue EF).
  const capacity = useQuery<CapacityFile | null>(c?.phase === "queued" ? "/api/capacity" : undefined, usePage().all).data;
  const fixing = step.status === "running" && !!step.check_fix;
  if (!c && !fixing) return null;
  const disputed = set?.dispute;
  const time = c && formatClock(c.since, new Date());
  const text = c?.phase === "queued" ? queuedText(capacityWait(capacity, project, queue.id, step.id), project, c.since) ?? t("checks.queued", { time: time! })
    : c?.phase === "running" ? t("checks.running", { time: time! })
    : c?.phase === "base" ? t("checks.base", { check: c.check ?? disputed?.name ?? t("checks.disputed"), evidence: disputed?.evidence ?? "…", time: time! })
    : c?.phase === "decision" ? t("checks.decision", { check: disputed?.name ?? t("checks.disputed"), evidence: disputed?.evidence ?? "…" })
    : t("checks.fix", { fix: step.check_fix!, limit: step.check_fix_limit ?? "?", round: set?.round ?? 1 });
  const rows = set ? checkRows(set, stepChecks(queue.run?.checks, queue.checks)) : [];
  const warn = c?.phase === "decision" || fixing;
  return (
    <div className={`mt-4 rounded-lg border p-3 text-sm ${warn ? "border-warn/30 bg-warn/10" : "border-accent/30 bg-accent/5"}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-fg-3">{t("checks.title")}</p>
      <p className="mt-1 text-fg">{text}</p>
      {step.check_limit && fixing && <p className="mt-1 text-stop">{t("checks.limit", { limit: step.check_fix_limit ?? step.check_fix! - 1 })}</p>}
      {rows.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rows.map((r) => (
            <li key={r.name}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={`${ROW[r.state].tone} ${r.state === "running" ? "animate-pulse" : ""}`}>{ROW[r.state].mark}</span>
                <span className="text-fg">{r.name}</span>
                <span className={`text-xs ${ROW[r.state].tone}`}>{t(`checks.row.${r.state}`)}</span>
                {r.duration !== undefined && <span className="text-xs tabular-nums text-fg-3">{formatSeconds(r.duration)}</span>}
              </div>
              {r.tests.length > 0 && (
                <ul className="ml-5 mt-0.5 space-y-0.5 text-xs text-fg-2">
                  {r.tests.slice(0, 5).map((x) => <li key={x} className="truncate font-mono" title={x}>{x}</li>)}
                  {r.tests.length > 5 && <li>+{r.tests.length - 5}</li>}
                </ul>
              )}
              {r.log && <p className="ml-5 truncate font-mono text-xs text-fg-3" title={r.log}>{r.log}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The summary, the stop's reason, and the progress while it runs. */
export function Summary({ queue, step }: InQueue) {
  if (!step.summary && !step.reason && !step.progress) return null;
  return (
    <div className="mt-4 rounded-lg bg-surface-2 p-3 text-sm">
      {step.summary && <p><span className="text-fg-3">{t("details.summary")} </span>{step.summary}</p>}
      {step.reason && step.status !== "rejected" && (
        <div className="text-stop"><span className="text-fg-3">{t("details.reason")} </span>
          {/* The stop's condition behind "more", when this step's stop has it apart. */}
          <StopReason reason={step.reason} condition={queue.status === "stopped" && queue.stop_step === step.id ? queue.stop?.condition : undefined} className="inline" />
        </div>
      )}
      {step.progress && step.status === "running" && (
        <p><span className="text-fg-3">{t("details.now")} </span>{step.progress.text} <span className="text-xs text-fg-3">(<TimeAgo at={step.progress.at} />)</span></p>
      )}
    </div>
  );
}

/** Whose review it is: the orchestrator's, or the user's (with the orchestrator's reason for handing it over). */
export function ReviewNotes({ step, reviewing, orchestratorAsks }: StepProps & { reviewing: boolean; orchestratorAsks?: string }) {
  return (
    <>
      {reviewedByOrchestrator(step) && (
        <Section title={t("details.orchestratorReview")}>
          <p className="text-sm text-fg-2">{t("details.orchestratorReviewText")}</p>
        </Section>
      )}
      {reviewing && (
        <Section title={t("details.yourReview")}>
          {orchestratorAsks && <p className="mb-2 text-sm text-fg"><span className="text-fg-3">{t("details.orchestratorAsks")} </span>{orchestratorAsks}</p>}
          <p className="text-sm text-fg-2">{t("details.yourReviewText")}</p>
        </Section>
      )}
    </>
  );
}

/** The send-backs of the step: by whom, when, and whether they reached the worker. */
export function SentBack({ step }: StepProps) {
  if (!step.sent_back.length) return null;
  return (
    <Section title={t("details.sentBack")}>
      <ul className="space-y-2">
        {step.sent_back.map((b) => (
          <li key={b.id} className="text-sm">
            <div className="text-xs text-fg-3">
              {t(b.by === "user" ? "details.sentBack.you" : "details.sentBack.orchestrator")} · <TimeAgo at={b.at} /> · {b.to_user ? t("details.sentBack.toUser") : b.delivered ? t("review.round", { round: b.round }) : t("details.sentBack.onItsWay")}
            </div>
            <p className="whitespace-pre-wrap text-fg">{b.text}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** A message to the agent at work on the step. */
export function MessageAgent({ project, queue, step, session }: Writes & { session: SessionView }) {
  const { reload: onChanged } = usePage();
  return (
    <Section title={t("details.messageAgent")} aside={<span className="text-xs text-fg-3">{t("details.messageAgentAside")}</span>}>
      <Composer
        draft={draftKey(project, "message", queue.id, step.id)}
        placeholder={t("details.messagePlaceholder")}
        button={t("details.send")}
        onSubmit={async (text) => { await act(project, "POST", `/sessions/${enc(session.id)}/messages`, { text, queue: queue.id, step: step.id }); onChanged(); }}
      />
    </Section>
  );
}

/** The state recorded on the step by hand (nexus queue set). */
export function StatusNote({ step }: StepProps) {
  if (!step.status_note) return null;
  return (
    <Section title={t("details.recordedState")}>
      <Expandable text={step.status_note} />
    </Section>
  );
}

/** The goal, the acceptance criteria, the review to prepare and the step's tags. */
export function GoalAcceptance({ step }: StepProps) {
  return (
    <>
      {step.goal && <Section title={t("details.goal")}><Markdown>{step.goal}</Markdown></Section>}
      {step.acceptance.length > 0 && (
        <Section title={t("approval.acceptance")}>
          <ul className="space-y-1.5">
            {step.acceptance.map((a, i) => (
              <li key={i} className="flex gap-2 text-sm text-fg"><span className="text-fg-3">◇</span><Markdown className="[&_p]:m-0">{a}</Markdown></li>
            ))}
          </ul>
        </Section>
      )}
      {step.review?.prepare && <Section title={t("details.reviewToPrepare")}><Markdown>{step.review.prepare}</Markdown></Section>}
      <StepTags step={step} />
    </>
  );
}

/**
 * Where a review item that is no picture opens: a file in the file viewer, formatted (Markdown rendered, JSON
 * indented, CSV as a table; FileView.tsx), a plain click staying in the dashboard and Ctrl+click opening it in a new
 * tab; a web link in a new tab.
 */
function materialLink(project: string, r: StepView["review_items"][number]) {
  if (!r.path) return { href: r.url!, target: "_blank", rel: "noreferrer" };
  const path = r.path;
  return {
    href: fileHref(project, path),
    onClick: (e: React.MouseEvent) => { if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); nav.file(path); },
  };
}

/** The review material as tiles: a picture opens in the picture viewer, a file in the file viewer, a link in a new tab. */
export function Material({ project, step, pairs }: StepProps & { project: string; pairs: Pairs }) {
  if (!step.review_items.length) return null;
  return (
    <Section title={t("queue.reviewMaterial")}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {step.review_items.map((r, i) => {
          const href = r.path ? fileUrl(project, r.path) : r.url!;
          const caption = <div className="truncate px-2 py-1 text-xs text-fg-2 group-hover:text-fg">{r.label ?? r.path ?? r.url}{r.round ? ` · ${t("review.round", { round: r.round })}` : ""}</div>;
          const tile = "group overflow-hidden rounded-lg border border-line bg-canvas text-left hover:border-fg-3/60";
          if (isImage(r)) {
            const n = step.review_items.slice(0, i).filter(isImage).length;
            return (
              <button key={i} onClick={() => nav.open(`viewer:${n}`)} className={`${tile} relative`}>
                <img src={href} alt={r.label ?? ""} className="aspect-video w-full object-cover" loading="lazy" />
                <PictureBadges marks={step.pictures[r.path!]} paired={!!pairs[n]?.before} />
                {caption}
              </button>
            );
          }
          return (
            <a key={i} {...materialLink(project, r)} className={tile}>
              <div className="flex aspect-video items-center justify-center text-2xl text-fg-3">{r.url ? "↗" : "▤"}</div>
              {caption}
            </a>
          );
        })}
      </div>
    </Section>
  );
}

/** The step's checks, every round. */
export function StepChecks({ step }: StepProps) {
  if (!step.checks.length) return null;
  return (
    <Section title={t("details.checks")}>
      <ul className="space-y-1 text-sm">
        {step.checks.map((c, i) => (
          <li key={i} className="flex gap-2">
            <span className={checkMark(c).tone}>{checkMark(c).mark}</span>
            <span className="text-fg">{c.name}</span>
            {c.duration !== undefined && <span className="tabular-nums text-fg-2">{formatSeconds(c.duration)}</span>}
            {c.summary && <span className="text-fg-3">{c.summary}</span>}
            {c.by === "nexus" && <span className="text-xs text-fg-3">{t("details.checks.byNexus")}</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The metrics the step's worker recorded (the latest value of each; a check's time only when it is beyond a
 * threshold): a value beyond its metric's warning threshold in the warn colour, with ⚠ and the threshold in words.
 * The project's Stats tab has their course over the steps.
 */
export function StepMetrics({ step }: StepProps) {
  const rows = stepMetrics(step.metrics);
  if (!rows.length) return null;
  return (
    <Section title={t("details.metrics")}>
      <ul className="space-y-1 text-sm">
        {rows.map((m) => (
          <li key={m.name} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-fg">{m.name}</span>
            <span className={`tabular-nums ${m.warn ? "font-semibold text-warn" : "text-fg-2"}`}>{metricValueText(m.value, m.unit)}</span>
            {m.warn && <span className="text-xs text-warn">{t("details.metricBeyond", { limit: metricValueText(m.warn.limit, m.unit) })}</span>}
            {m.commit && <span className="font-mono text-xs text-fg-3">{m.commit.slice(0, 7)}</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The notes on the step (to the worker, or to the orchestrator while it holds the review), and a new one while open. */
export function Notes({ project, queue, step, forOrchestrator, notesOpen, readOnly = false }: Writes & { forOrchestrator: boolean; notesOpen: boolean; readOnly?: boolean }) {
  const { reload: onChanged } = usePage();
  return (
    <Section title={t("details.notes")} aside={<span className="text-xs text-fg-3">{t(forOrchestrator ? "details.notesToOrchestrator" : "details.notesDelivered")}</span>}>
      <div className="space-y-2">
        {step.notes.map((n) => (
          <div key={n.id} className="rounded-lg border border-line p-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-fg-3">
              <span>{t(n.to === "orchestrator" ? "details.note.fromTo" : "details.note.from", { from: n.from })}</span><TimeAgo at={n.at} />
              <span className={`ml-auto ${n.read_at ? "text-ok" : "text-info"}`}>{t(n.read_at ? (n.to === "orchestrator" ? "details.note.told" : "details.note.delivered") : n.to === "orchestrator" ? "details.note.toOrchestrator" : "details.note.waiting")}</span>
              {!n.read_at && !readOnly && <WithdrawNote project={project} queue={queue.id} step={step.id} note={n.id} />}
            </div>
            <Markdown>{n.body}</Markdown>
          </div>
        ))}
        {step.notes.length === 0 && !notesOpen && <p className="text-sm text-fg-3">{t("approval.none")}</p>}
      </div>
      {notesOpen && (
        <div className="mt-3">
          <Composer
            draft={draftKey(project, "note", queue.id, step.id)}
            placeholder={t(forOrchestrator ? "details.notePlaceholderOrchestrator" : "details.notePlaceholder", { step: step.id })}
            button={t("details.addNote")}
            onSubmit={async (text) => { await act(project, "POST", `/queues/${enc(queue.id)}/steps/${enc(step.id)}/notes`, { text }); onChanged(); }}
          />
        </div>
      )}
    </Section>
  );
}

function WithdrawNote({ project, queue, step, note }: { project: string; queue: string; step: string; note: string; }) {
  const { reload: onChanged } = usePage();
  const [error, setError] = useState<string>();
  return (
    <>
      {error && <span className="text-danger">{error}</span>}
      <button
        className="text-fg-3 hover:text-danger"
        onClick={() => void act(project, "DELETE", `/queues/${enc(queue)}/steps/${enc(step)}/notes/${enc(note)}`).then(onChanged, (e: Error) => setError(e.message))}
      >{t("details.note.withdraw")}</button>
    </>
  );
}

/** The messages sent to the step's session, read or not. */
export function Messages({ step }: StepProps) {
  if (!step.messages.length) return null;
  return (
    <Section title={t("details.messages")}>
      <div className="space-y-2">
        {step.messages.map((m) => (
          <div key={m.id} className="rounded-lg border border-line p-3 text-sm">
            <div className="mb-1 flex gap-2 text-xs text-fg-3">
              <span>{t("details.note.from", { from: m.from })}</span><TimeAgo at={m.at} />
              <span className={`ml-auto ${m.read_at ? "text-ok" : "text-info"}`}>{t(m.read_at ? "details.message.read" : "details.message.unread")}</span>
            </div>
            {m.type === "message" && <Markdown>{m.text}</Markdown>}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** The step's events, oldest first. */
export function Timeline({ step }: StepProps) {
  if (!step.timeline.length) return null;
  return (
    <Section title={t("details.timeline")}>
      <ol className="relative space-y-2 border-l border-line pl-4">
        {step.timeline.map((e) => (
          <li key={e.id} className="text-sm">
            <span className="absolute -left-[3px] mt-1.5 h-1.5 w-1.5 rounded-full bg-fg-3" />
            <span className="font-mono text-xs text-fg-3">{e.type}</span>{" "}
            <span className="text-fg">{describe(e)}</span>{" "}
            <span className="text-xs text-fg-3"><TimeAgo at={e.at} /></span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/**
 * While the step waits for the user's review (UX proposals, 13 and 14): the pictures large, two per row, with their
 * marks; the other material as links; the checks, the goal, the commits and the timeline on one line, folded.
 */
export function ReviewPictures({ project, queue, step, pairs, orchestratorAsks }: InQueue & {
  project: string; pairs: Pairs; orchestratorAsks?: string;
}) {
  const [fold, setFold] = useState<{ goal?: boolean; commits?: boolean; timeline?: boolean }>({});
  const marked = pairs.filter((p) => step.pictures[p.item.path!]?.accepted).length;
  const others = step.review_items.filter((r) => !isImage(r));
  return (
    <>
      {orchestratorAsks && <p className="mt-4 text-sm text-fg"><span className="text-fg-3">{t("details.orchestratorAsks")} </span>{orchestratorAsks}</p>}
      {pairs.length > 0 && (
        <section className="mt-5">
          <div className="mb-2 flex items-baseline gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-3">{t("details.pictures", { count: pairs.length })}</h3>
            <span className="ml-auto text-xs text-fg-3">{marked ? <>{t("details.marked", { count: marked })} <span className="text-ok">✓</span></> : t("details.noneMarked")}</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {pairs.map(({ item: r, before }, n) => (
              <button key={r.path} onClick={() => nav.open(`viewer:${n}`)} className="group relative overflow-hidden rounded-lg border border-line bg-surface-2 text-left hover:border-fg-3/60">
                <img src={fileUrl(project, r.path!)} alt={r.label ?? ""} className="aspect-[16/10] w-full bg-canvas object-cover object-top" loading="lazy" />
                <span className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg">
                  {step.pictures[r.path!]?.accepted ? <span className="text-ok" title={t("details.youMarked")}>✓</span> : before ? <span className="text-fg-3" title={t("details.hasBefore")}>⇄</span> : null}
                  <span className="truncate">{r.label ?? r.path!.split("/").at(-1)}{r.round ? ` · ${t("review.round", { round: r.round })}` : ""}</span>
                  {!!step.pictures[r.path!]?.comments.length && <span className="ml-auto shrink-0 text-info" title={t("viewer.comments")}>💬 {step.pictures[r.path!]!.comments.length}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {others.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {others.map((r, i) => (
            <a key={i} {...materialLink(project, r)} className="text-accent hover:underline">
              {r.url ? "↗" : "▤"} {r.label ?? r.path ?? r.url}
            </a>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {latestChecks(step.checks).map((c, i) => <span key={i} title={c.summary} className={checkMark(c).tone}>{checkMark(c).mark} {c.name}{c.duration !== undefined && <span className="tabular-nums text-fg-3"> {formatSeconds(c.duration)}</span>}</span>)}
        {(step.goal || step.acceptance.length > 0 || step.review?.prepare) && <Fold label={t("details.goalAcceptance")} open={!!fold.goal} onToggle={() => setFold((f) => ({ ...f, goal: !f.goal }))} />}
        <StepCommits project={project} queue={queue.id} step={step.id} toggle={{ open: !!fold.commits, onToggle: () => setFold((f) => ({ ...f, commits: !f.commits })) }} />
        {step.timeline.length > 0 && <Fold label={t("details.timeline")} open={!!fold.timeline} onToggle={() => setFold((f) => ({ ...f, timeline: !f.timeline }))} />}
      </div>
      {fold.goal && <GoalAcceptance step={step} />}
      {fold.commits && <StepCommits project={project} queue={queue.id} step={step.id} />}
      {fold.timeline && <Timeline step={step} />}
    </>
  );
}

/** A provisional acceptance (review level 3): waiting for the user (Confirm, Fix it), confirmed, or a fix asked. */
export function ProvisionalBox({ project, queue, step }: Writes) {
  const { reload: onChanged } = usePage();
  const p = step.provisional;
  if (!p) return null;
  return (
    <div className={`mb-5 rounded-lg border px-4 py-3 text-sm ${pendingProvisional(step) ? "border-review/40 bg-review/5" : "border-line"}`}>
      <p className="text-xs text-fg-3">{p.fix ? rich("provisional.fixAskedAt", { time: <TimeAgo key="t" at={p.fix.at} /> }) : p.confirmed ? rich("provisional.confirmedAt", { time: <TimeAgo key="t" at={p.confirmed} /> }) : rich("provisional.box", { time: <TimeAgo key="t" at={p.at} /> })}</p>
      {p.text && <p className="mt-1 text-fg"><span className="text-fg-3">{t("provisional.lookAt")} </span>{p.text}</p>}
      {p.fix && <p className="mt-1 text-fg">{p.fix.text}</p>}
      {pendingProvisional(step) && <>
        <p className="mt-1 text-xs text-fg-2">{t("provisional.boxHint")}</p>
        <div className="mt-2.5"><ProvisionalActions project={project} queue={queue.id} step={step.id} onDone={onChanged} wide /></div>
      </>}
    </div>
  );
}
