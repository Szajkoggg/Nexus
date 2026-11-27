// A queue's panel: its state, a stop and its way on, the approval and its history, the run controls, the changes made
// through Nexus, the description, stop conditions and checks; Continue or Approve in its action bar.
import { useState } from "react";
import type { StatusChange } from "@nexus/protocol";
import { stepValuesText } from "@nexus/protocol/steps";
import { importedFrom } from "@nexus/protocol/ideas";
import { act, enc, fileUrl, projectUrl, type ProjectState, type QueueView } from "../../api.ts";
import { needsApproval, levelWords, queueChecks } from "../../approval.ts";
import { approvalHistory, approvalWord, canWithdrawApproval, queueOver } from "../../details.ts";
import { draftKey } from "../../drafts.ts";
import { rich, t, type Key } from "../../i18n.ts";
import { queueStatus } from "../../queueStatus.ts";
import { needsWorkChoice, stopDecision, type LeftState, type WorkChoice } from "../../stopDecision.ts";
import { AskButton, Checks, CompactSteps, SettingsLine, useApprove, useCtrlEnter } from "../Approval.tsx";
import { SkipClosingBox, closingNotRun, stepMark } from "../Closing.tsx";
import { LevelPicker, levelChangeable } from "../Levels.tsx";
import { nav } from "../../nav.ts";
import { StepRow } from "../QueueRow.tsx";
import { RunControls } from "../Run.tsx";
import { StopBox, stopVersion, useContinue, useLeft } from "../Stop.tsx";
import { ActionBar, Button, Composer, Expandable, Markdown, PanelBody, PanelHeader, Section, StatusBadge, TimeAgo, statusWord, type MenuEntry } from "../ui.tsx";
import { BranchLine, WorktreeActions } from "./git.tsx";
import type { PanelProps } from "./props.ts";
import { Question } from "./questions.tsx";
import { usePage } from "../../page.ts";

const WHO: Record<StatusChange["by"], Key> = { user_approval: "details.change.byApproval", user_continue: "details.change.byContinue", orchestrator: "details.change.byOrchestrator", nexus: "details.change.byNexus" };

export function QueueDetail({ project, queue, onClose, of, chat = [], onFull }: PanelProps) {
  const { reload: onChanged } = usePage();
  const id = project.project.id;
  const inherited = project.project.defaults.stop_conditions;
  const checks = queueChecks(project.project, queue);
  const imported = importedFrom(queue.source);
  // A stopped queue: what its stopped step left, and the user's Keep or Discard, shared by Continue and the approval.
  // The same read as the step's line and the waiting cards (Stop.tsx), so they never disagree.
  const leftState = useLeft(id, queue.id, queue.status === "stopped", stopVersion(queue));
  const left = leftState === "error" ? undefined : leftState;
  const [work, setWork] = useState<WorkChoice>();
  const needsChoice = needsWorkChoice(left);
  // A queue waiting for approval: its steps as the compact list (UX proposals, 13 left), the description, stop
  // conditions and checks folded in it, its run settings in the header.
  const approving = needsApproval(queue);
  const honest = queueStatus(queue);
  const waitsApproval = honest.tone === "approval";
  const history = approvalHistory(queue);

  return (
    <>
      <PanelHeader
        where={t("details.queueWhere", { project: project.project.name })} of={of}
        title={<><span className="mr-2 font-mono text-fg-3">{queue.id}</span>{queue.title}</>}
        status={<>
          {/* A revision waiting for approval says so first, in the approval colour, with the planned start after it. */}
          {waitsApproval && <span className="font-medium text-info">{honest.label}</span>}
          <StatusBadge status={queue.status} />
          <span>{t("details.revision", { revision: queue.revision })}</span>
          {approving && <SettingsLine project={project} queue={queue} />}
          {queue.branch && !approving && <span className="font-mono">{queue.branch}</span>}
          {queue.worktree && !approving && <span className="font-mono">{queue.worktree}</span>}
          <span className={queue.approved ? "text-ok" : "text-fg-3"}>
            {t(approvalWord(queue))}
          </span>
        </>}
        onClose={onClose}
      />
      <PanelBody>
      <BranchLine project={id} queue={queue.id} />
      <WorktreeActions project={id} root={project.project.root} queue={queue} />

      {queue.status === "stopped"
        ? <StopBox project={id} queue={queue} left={left ?? undefined} work={work} setWork={setWork} needsChoice={needsChoice} pushAccepted={project.project.defaults.push_accepted} />
        : queue.status_reason && <Section title={t("details.state")}><Expandable text={queue.status_reason} /></Section>}
      {approving && <CompactSteps project={project} queue={queue} chat={chat} onFull={onFull} onChanged={onChanged} />}
      {queue.report && (
        <Section title={t("details.report")}>
          <p className="text-sm text-fg">{queue.report.summary}</p>
          <a className="text-sm text-accent underline" href={fileUrl(id, queue.report.path)} target="_blank" rel="noreferrer">{t("details.openReport")}</a>
        </Section>
      )}
      {/* A finished or cancelled queue is no longer in the queue list: its steps are here, each opening read-only. */}
      {queueOver(queue) && (
        <Section title={t("details.steps")}>
          <div className="-mx-2">{queue.steps.map((s) => <StepRow key={s.id} step={s} queue={queue} onStep={() => nav.item(id, queue.id, s.id)} />)}</div>
        </Section>
      )}
      {queue.questions.length > 0 && <Section title={t("details.questions")}>{queue.questions.map((q) => <Question key={q.qid} q={q} project={id} />)}</Section>}

      {!approving && <OwnValues queue={queue} />}
      {!approving && !queueOver(queue) && <StepLevels project={project} queue={queue} />}

      {history.length > 0 && <Section title={t("details.approval")}>
        {history.map((a, i) => (
            <p key={i} className={`mb-1 text-sm ${a.withdrawn ? "text-stop/90" : "text-fg"}`}>
              {t("details.approval.revision", { revision: a.revision })} · {a.withdrawn ? `${t("details.approval.withdrawnAt")} ` : ""}<TimeAgo at={a.at} />
              {!a.withdrawn && a.words && <> · <q className="italic">{a.words}</q></>}
              {a.withdrawn && a.reason && <> · <q className="italic">{a.reason}</q></>}
            </p>
          ))}
      </Section>}

      <RunControls project={project} queue={queue} />

      <Changes entries={queue.changes} queue={queue} />

      {!approving && queue.description && <Section title={t("approval.description")}><Expandable text={queue.description} lines={6} /></Section>}

      {!approving && <Section title={t("approval.stopConditions")}>
        <ul className="space-y-1.5 text-sm text-fg">
          {queue.stop_conditions.map((c, i) => <li key={i} className="flex gap-2"><span className="text-stop/70">■</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
          {inherited.map((c, i) => <li key={`p${i}`} className="flex gap-2 text-fg-3"><span>□</span><span>{c} <span className="text-xs">{t("approval.fromProject")}</span></span></li>)}
          {queue.stop_conditions.length + inherited.length === 0 && <li className="text-fg-3">{t("approval.none")}</li>}
        </ul>
      </Section>}
      {!approving && checks.length > 0 && (
        <Section title={t("approval.checks")}><Checks checks={checks} /></Section>
      )}
      {imported && (
        <p className="mt-6 text-xs text-fg-3">{rich("details.imported", { path: <span key="path" className="font-mono">{imported.path}</span>, time: <TimeAgo key="time" at={imported.imported_at} /> })}</p>
      )}
      </PanelBody>
      <QueueBar key={queue.id} project={project} queue={queue} left={leftState} work={work} needsChoice={needsChoice} />
    </>
  );
}

/**
 * The bar of a queue: Continue on a stopped queue whose revision is approved; Approve revision N (words with it under
 * ⋯) on one that is not; Withdraw approval (a queue approved but never started) and the review policy under ⋯.
 */
function QueueBar({ project, queue, left, work, needsChoice }: {
  project: ProjectState; queue: QueueView; left: LeftState; work?: WorkChoice; needsChoice: boolean;
}) {
  const { reload: onChanged, reloaded } = usePage();
  const id = project.project.id;
  const stopped = queue.status === "stopped";
  // A stop's buttons and hint, as everywhere the stop is shown; Continue itself is the one in Stop.tsx.
  const d = stopped ? stopDecision({ approved: queue.approved, revision: queue.revision, left, work }) : undefined;
  const cont = useContinue({ project: id, queue: queue.id, onChanged });
  // Continue may skip the queue's closing refactoring step while it has not run (the user's choice, not an agent's).
  const canSkipClosing = stopped && queue.approved && closingNotRun(queue);
  const [skipClosing, setSkipClosing] = useState(false);
  // The approval (Approval.tsx, the same in the full view): its words, Keep or Discard, what it pins; Ctrl+Enter.
  const a = useApprove({ project: id, queue, left, work, reloaded });
  // A finished or cancelled queue is only read: no approval, no review policy.
  const over = queueOver(queue);
  // Approving is open while the revision is not approved and the queue is not over.
  const approvable = !queue.approved && !over;
  useCtrlEnter(approvable, a.submit);
  const [error, setError] = useState<string>();
  const canWithdraw = canWithdrawApproval(queue);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  // The level asked for shows at once, the picker in progress, until the state after the write shows it (page.ts).
  const [askedLevel, setAskedLevel] = useState<{ level: number | null }>();
  const setLevel = (review_level: number | null) => {
    setAskedLevel({ level: review_level }); setError(undefined);
    void act(id, "PATCH", `/queues/${enc(queue.id)}`, { review_level }).then(() => reloaded(projectUrl(id, "/state")), (e: Error) => setError(e.message))
      .finally(() => setAskedLevel(undefined));
  };
  const projectDefault = t("details.level.projectDefault", { level: levelWords(project.project.defaults.review_level) });
  const policy = queue.review_level ? levelWords(queue.review_level) : projectDefault;

  const menu: MenuEntry[] = [
    ...(approvable ? a.menu : []),
    ...(canWithdraw && !withdrawOpen ? [{ label: t("details.withdraw.menu"), danger: true, onSelect: () => setWithdrawOpen(true) }] : []),
    ...(!policyOpen && !over ? [{ label: t("details.level.menu", { level: policy }), onSelect: () => setPolicyOpen(true) }] : []),
  ];
  const fail = cont.error ?? error ?? a.words.error;
  const said = cont.note ?? a.note;
  const hint = fail ? <span className="text-danger">{fail}</span>
    : said ? <span className="text-info">{said}</span>
    : stopped && queue.approved ? d!.hint
    : approvable ? a.hint
    : undefined;
  const primary = stopped && queue.approved
    ? d!.confirm && <Button disabled={cont.busy || d!.confirm.disabled} onClick={() => void cont.go(d!.needsChoice, work, canSkipClosing && skipClosing)}>{d!.confirm.label}</Button>
    : approvable
      ? <Button disabled={a.disabled} onClick={a.submit}>{a.label}</Button>
      : undefined;
  const opened = (!queue.approved && a.wordsOpen) || (canWithdraw && withdrawOpen) || policyOpen;
  // A finished or cancelled queue's panel has no bar: nothing is left to do in it.
  if (over && !hint && !menu.length && !opened) return null;
  return (
    <ActionBar hint={hint} menu={menu.length ? menu : undefined} secondary={approvable && <AskButton project={id} queue={queue} />} primary={primary}
      left={canSkipClosing ? <SkipClosingBox checked={skipClosing} onChange={setSkipClosing} /> : approvable && a.skipBox}>
      {opened && (
        <div className="space-y-4">
          {!queue.approved && a.wordsBox}
          {canWithdraw && withdrawOpen && <WithdrawApproval project={id} queue={queue.id} onCancel={() => setWithdrawOpen(false)} />}
          {policyOpen && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
              <label className="flex flex-wrap items-center gap-2">
                {t("details.level.label")}
                <select
                  value={(askedLevel ? askedLevel.level : queue.review_level) ?? ""} disabled={!!askedLevel} aria-busy={!!askedLevel}
                  onChange={(e) => setLevel(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm disabled:opacity-60"
                >
                  <option value="">{projectDefault}</option>
                  <option value="1">{t("details.level.1")}</option>
                  <option value="2">{t("details.level.2")}</option>
                  <option value="3">{t("details.level.3")}</option>
                </select>
              </label>
              <Button variant="quiet" onClick={() => setPolicyOpen(false)}>{t("details.level.done")}</Button>
            </div>
          )}
        </div>
      )}
    </ActionBar>
  );
}

/** Status changes made through Nexus (queue.yaml's changes): who, when, what and why; newest first. */
export function Changes({ entries, queue }: { entries: StatusChange[]; queue: QueueView }) {
  if (!entries.length) return null;
  const what = (c: StatusChange) => {
    switch (c.kind) {
      case "lift": return c.revision ? t("details.change.liftedRevision", { revision: c.revision }) : t("details.change.lifted");
      case "proposal": return t("details.change.proposal");
      case "run": return t("details.change.run");
      case "work": return t(c.to === "kept" ? "details.change.kept" : "details.change.discarded", { step: c.step ?? "", count: c.commits?.length ?? 0 });
      case "status":
      default: return c.step ? t("details.change.step", { step: c.step, from: statusWord(c.from), to: statusWord(c.to) }) : t("details.change.queue", { queue: queue.id, from: statusWord(c.from), to: statusWord(c.to) });
    }
  };
  return (
    <Section title={t("details.changes")}>
      <ul className="space-y-2">
        {[...entries].reverse().map((c, i) => (
          <li key={i} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-3">
              <span className={c.by === "orchestrator" ? "text-review" : "text-info"}>{t(WHO[c.by])}</span>
              <TimeAgo at={c.at} />
            </div>
            <div className="text-fg">{what(c)}</div>
            {c.reason && <div className="text-xs text-fg-2">{t(c.kind === "lift" ? "details.change.stopWas" : "details.change.why")} {c.reason}</div>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Takes the approval back from a queue that has never run (it is proposed again). A started queue is paused or
 * stopped instead, so this is not offered there.
 */
function WithdrawApproval({ project, queue, onCancel }: { project: string; queue: string; onCancel: () => void }) {
  const { reload: onChanged } = usePage();
  return (
    <div className="rounded-lg border border-stop/30 bg-stop/5 p-3">
      <p className="mb-2 text-sm text-fg">
        {t("details.withdraw.text")}
      </p>
      <Composer
        rows={2}
        allowEmpty
        draft={draftKey(project, "withdraw", queue)}
        placeholder={t("details.reject.why")}
        button={t("details.withdraw.button")}
        extra={<Button variant="quiet" onClick={onCancel}>{t("common.cancel")}</Button>}
        onSubmit={async (reason) => { await act(project, "POST", `/queues/${enc(queue)}/withdraw`, { reason }); onChanged(); }}
      />
    </div>
  );
}

/**
 * An approved queue's steps whose review is still to come, each with its level picker: the user may decide later that
 * they review a step themselves (or leave it to the orchestrator). Setting a level asks for no new approval.
 */
function StepLevels({ project, queue }: { project: ProjectState; queue: QueueView; }) {
  const open = queue.steps.filter(levelChangeable);
  if (!open.length) return null;
  return (
    <Section title={t("details.stepLevels")}>
      <ul className="space-y-1.5">
        {open.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="w-16 shrink-0 font-mono text-xs text-fg-3" title={s.id}>{stepMark(s)}</span>
            <span className="min-w-0 flex-1 text-fg">{s.title}</span>
            <LevelPicker project={project.project.id} queue={queue.id} step={s} away={project.away} />
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-fg-3">{t("details.stepLevelsText")}</p>
    </Section>
  );
}

/**
 * The steps that name their own runtime, model or effort, each with its values, so they are seen before approving;
 * nothing when every step runs on the run's.
 */
function OwnValues({ queue }: { queue: QueueView }) {
  const own = queue.steps.filter((s) => stepValuesText(s));
  if (!own.length) return null;
  return (
    <Section title={t("details.ownValues")}>
      <ul className="space-y-1 text-sm">
        {own.map((s) => (
          <li key={s.id} className="flex flex-wrap gap-x-2">
            <span className="font-mono text-fg-3">{s.id}</span>
            <span className="text-fg">{s.title}</span>
            <span className="text-review">⚙ {stepValuesText(s)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-fg-3">{t("details.ownValuesText")}</p>
    </Section>
  );
}
