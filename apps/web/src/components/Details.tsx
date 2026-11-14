import { useState, type ReactNode } from "react";
import type { ChatEntry, Event, StatusChange } from "@nexus/protocol";
import { stopPlace } from "@nexus/protocol/attention";
import { latestChecks, stepValuesText } from "@nexus/protocol/steps";
import { act, actResult, enc, fileUrl, useFetch, type ProjectState, type QuestionView, type QueueView, type StepView } from "../api.ts";
import { comparisonOf, noteTargets, pairPictures, showsReviewActions } from "../review.ts";
import { ActionBar, Button, Composer, Expandable, Markdown, PanelBody, PanelHeader, Section, StatusBadge, StepTimes, TEXTAREA, TimeAgo, reviewLabel, statusWord, useDraftText, type MenuEntry } from "./ui.tsx";
import { Activity, RetryNote, RunControls } from "./Run.tsx";
import { StepRefusals } from "./Refusals.tsx";
import { draftKey, readDraft } from "../drafts.ts";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { usePhone } from "../phone.ts";
import { ImageViewer, type ViewerImage } from "./Viewer.tsx";
import { StepChat } from "./Chat.tsx";
import { StopBox, StopReason, stopVersion, useContinue, useLeft } from "./Stop.tsx";
import { AskButton, CompactSteps, SettingsLine, useApprove, useCtrlEnter } from "./Approval.tsx";
import { needsApproval, levelWords } from "../approval.ts";
import { queueStatus } from "../queueStatus.ts";
import { needsWorkChoice, stopDecision, type LeftState, type LeftView, type WorkChoice } from "../stopDecision.ts";
import { formatSeconds, rich, t, type Key } from "../i18n.ts";
import { LevelMark, ProvisionalActions, levelShort, levelTitle, pendingProvisional, provisionalWord } from "./Levels.tsx";

interface Props {
  project: ProjectState; queue: QueueView; onChanged: () => void; onClose: () => void;
  /** The orchestrator's chat: where its message with a queue's draft is found (the approval's compact list). */
  chat?: readonly ChatEntry[];
  /** Switches a queue waiting for approval to the full view (Approval.tsx). */
  onFull?: () => void;
  /** Where it stands in the waiting list ("2 of 6 waiting"), when it waits for the user (on the phone). */
  of?: string;
}

// ---------------------------------------------------------------- step

export function StepDetail({ project, queue, step, onChanged, onClose, of }: Props & { step: StepView }) {
  const id = project.project.id;
  const questions = queue.questions.filter((q) => q.step === step.id);
  const live = (step.status === "running" || step.status === "waiting") && step.session;
  const session = live ? project.sessions.find((s) => s.id === step.session) : undefined;
  // A note on a step the orchestrator holds in review goes to the orchestrator, not the worker.
  const forOrchestrator = step.status === "review" && step.review_with === "orchestrator";
  const notesOpen = step.status === "pending" || step.status === "stopped" || forOrchestrator;
  // Review images open in the in-app viewer, a layer above the step (Back closes it); other items as links.
  const isImage = (r: StepView["review_items"][number]) => !!r.path && /\.(png|jpe?g|gif|webp|svg)$/i.test(r.path);
  // Each picture with what it is compared with: by its view key and role, else (older material) an explicit --before
  // or the same label in an earlier round.
  const pictures = pairPictures(step.review_items.filter(isImage));
  const fileName = (p: string) => p.split(/[\\/]/).at(-1)!;
  const images: ViewerImage[] = pictures.map((pair) => {
    const { item: r, before, beforeLabel, other } = pair;
    return {
      src: fileUrl(id, r.path!), label: r.label ?? fileName(r.path!), round: r.round, key: r.key, comparison: comparisonOf(pair),
      // A keyed counterpart by its label; an explicit before by its file name; one paired by label by its round.
      before: before ? { src: fileUrl(id, before), label: other?.key ? other.label ?? fileName(before) : beforeLabel === t("review.role.before") ? fileName(before) : beforeLabel ?? t("review.role.before") } : undefined,
      accepted: !!step.pictures[r.path!]?.accepted, comments: step.pictures[r.path!]?.comments.length ?? 0,
    };
  });
  const viewing = layerValue(useNav(), "viewer");
  const shown = viewing === undefined ? undefined : Math.min(Math.max(0, Number(viewing) || 0), images.length - 1);
  // The action bar: the user's review when the step waits for it; else the answer to the step's open question (the
  // first, if there are several; the others keep their answer box in their card).
  const reviewing = showsReviewActions(step);
  const asking = reviewing ? undefined : questions.find((q) => q.state === "open" || q.state === "escalated");
  // On the phone a step with an open question is the question's sheet: the question first, its options as buttons,
  // the answer in the body and Answer in the bar; the step's details follow below it.
  const phone = usePhone();
  const questionFirst = phone && !!asking;
  const [fold, setFold] = useState<{ goal?: boolean; commits?: boolean; timeline?: boolean }>({});
  // The step's parts. While it waits for the user's review the summary and the pictures come first (UX proposals,
  // 13 and 14): the pictures large, two per row, with their marks; the checks, the goal, the commits and the timeline
  // on one line, folded; Accept in the action bar. Otherwise the usual order.
  const chat = (
    <>
      <StepChat project={id} queue={queue.id} step={step.id} version={project.generated_at} />
    </>
  );
  const retry = (
    <>
      {queue.run?.state === "retry_wait" && queue.run.step === step.id && (
        <div className="mt-4 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm">
          <RetryNote run={queue.run} className="text-sm" />
          {queue.run.reason && <p className="mt-1 text-xs text-fg-2">{queue.run.reason}</p>}
        </div>
      )}
    </>
  );
  const summary = (
    <>
      {(step.summary || step.reason || step.progress) && (
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
      )}
    </>
  );
  const reviewNotes = (
    <>
      {step.status === "review" && step.review_with === "orchestrator" && (
        <Section title={t("details.orchestratorReview")}>
          <p className="text-sm text-fg-2">{t("details.orchestratorReviewText")}</p>
        </Section>
      )}
      {reviewing && (
        <Section title={t("details.yourReview")}>
          {step.asked_user?.text && <p className="mb-2 text-sm text-fg"><span className="text-fg-3">{t("details.orchestratorAsks")} </span>{step.asked_user.text}</p>}
          <p className="text-sm text-fg-2">{t("details.yourReviewText")}</p>
        </Section>
      )}
    </>
  );
  const push = (
    <>
      <PushLine project={id} queue={queue} step={step.id} onChanged={onChanged} />
    </>
  );
  const rejected = (
    <>
      {step.status === "rejected" && <Rejected step={step} holding={queue.rejection?.step === step.id} />}
    </>
  );
  const sentBack = (
    <>
      {step.sent_back.length > 0 && (
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
      )}
    </>
  );
  const message = (
    <>
      {live && session && (
        <Section title={t("details.messageAgent")} aside={<span className="text-xs text-fg-3">{t("details.messageAgentAside")}</span>}>
          <Composer
            draft={draftKey(id, "message", queue.id, step.id)}
            placeholder={t("details.messagePlaceholder")}
            button={t("details.send")}
            onSubmit={async (text) => { await act(id, "POST", `/sessions/${enc(session.id)}/messages`, { text, queue: queue.id, step: step.id }); onChanged(); }}
          />
        </Section>
      )}
    </>
  );
  const questionsPart = (
    <>
      {questions.some((q) => !(questionFirst && q.qid === asking?.qid)) && (
        <Section title={t(questionFirst ? "details.otherQuestions" : "details.questions")}>
          {questions.filter((q) => !(questionFirst && q.qid === asking?.qid)).map((q) => <Question key={q.qid} q={q} project={id} onChanged={onChanged} inBar={q.qid === asking?.qid} />)}
        </Section>
      )}
    </>
  );
  const statusNote = (
    <>
      {step.status_note && (
        <Section title={t("details.recordedState")}>
          <Expandable text={step.status_note} />
        </Section>
      )}
    </>
  );
  const goalAcceptance = (
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
    </>
  );
  const material = (
    <>
      {step.review_items.length > 0 && (
        <Section title={t("queue.reviewMaterial")}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {step.review_items.map((r, i) => {
              const href = r.path ? fileUrl(id, r.path) : r.url!;
              const caption = <div className="truncate px-2 py-1 text-xs text-fg-2 group-hover:text-fg">{r.label ?? r.path ?? r.url}{r.round ? ` · ${t("review.round", { round: r.round })}` : ""}</div>;
              const tile = "group overflow-hidden rounded-lg border border-line bg-canvas text-left hover:border-fg-3/60";
              if (isImage(r)) {
                const n = step.review_items.slice(0, i).filter(isImage).length;
                return (
                  <button key={i} onClick={() => nav.open(`viewer:${n}`)} className={`${tile} relative`}>
                    <img src={href} alt={r.label ?? ""} className="aspect-video w-full object-cover" loading="lazy" />
                    <PictureBadges marks={step.pictures[r.path!]} paired={!!pictures[n]?.before} />
                    {caption}
                  </button>
                );
              }
              return (
                <a key={i} href={href} target="_blank" rel="noreferrer" className={tile}>
                  <div className="flex aspect-video items-center justify-center text-2xl text-fg-3">{r.url ? "↗" : "▤"}</div>
                  {caption}
                </a>
              );
            })}
          </div>
        </Section>
      )}
    </>
  );
  const viewer = (
    <>
      {shown !== undefined && images.length > 0 && (
        <ImageViewer images={images} index={shown} onIndex={(i) => nav.open(`viewer:${i}`)} onClose={() => nav.close("viewer")}
          back={step.id} context={`${project.project.name} · ${queue.id} · ${step.id} ${step.title}`}
          footer={(i) => <PictureActions key={pictures[i]!.item.path} project={id} queue={queue} step={step} path={pictures[i]!.item.path!} src={images[i]!.src} onChanged={onChanged} />} />
      )}
    </>
  );
  const checks = (
    <>
      {step.checks.length > 0 && (
        <Section title={t("details.checks")}>
          <ul className="space-y-1 text-sm">
            {step.checks.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className={c.ok ? "text-ok" : "text-danger"}>{c.ok ? "✓" : "✗"}</span>
                <span className="text-fg">{c.name}</span>
                {c.duration !== undefined && <span className="tabular-nums text-fg-2">{formatSeconds(c.duration)}</span>}
                {c.summary && <span className="text-fg-3">{c.summary}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
  const notes = (
    <>
      <Section title={t("details.notes")} aside={<span className="text-xs text-fg-3">{t(forOrchestrator ? "details.notesToOrchestrator" : "details.notesDelivered")}</span>}>
        <div className="space-y-2">
          {step.notes.map((n) => (
            <div key={n.id} className="rounded-lg border border-line p-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-fg-3">
                <span>{t(n.to === "orchestrator" ? "details.note.fromTo" : "details.note.from", { from: n.from })}</span><TimeAgo at={n.at} />
                <span className={`ml-auto ${n.read_at ? "text-ok" : "text-info"}`}>{t(n.read_at ? (n.to === "orchestrator" ? "details.note.told" : "details.note.delivered") : n.to === "orchestrator" ? "details.note.toOrchestrator" : "details.note.waiting")}</span>
                {!n.read_at && <WithdrawNote project={id} queue={queue.id} step={step.id} note={n.id} onChanged={onChanged} />}
              </div>
              <Markdown>{n.body}</Markdown>
            </div>
          ))}
          {step.notes.length === 0 && !notesOpen && <p className="text-sm text-fg-3">{t("approval.none")}</p>}
        </div>
        {notesOpen && (
          <div className="mt-3">
            <Composer
              draft={draftKey(id, "note", queue.id, step.id)}
              placeholder={t(forOrchestrator ? "details.notePlaceholderOrchestrator" : "details.notePlaceholder", { step: step.id })}
              button={t("details.addNote")}
              onSubmit={async (text) => { await act(id, "POST", `/queues/${enc(queue.id)}/steps/${enc(step.id)}/notes`, { text }); onChanged(); }}
            />
          </div>
        )}
      </Section>
    </>
  );
  const messages = (
    <>
      {step.messages.length > 0 && (
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
      )}
    </>
  );
  const refusals = (
    <>
      <StepRefusals project={project} queue={queue.id} step={step.id} />
    </>
  );
  const changes = (
    <>
      <Changes entries={queue.changes.filter((c) => c.step === step.id)} queue={queue} />
    </>
  );
  const activity = (
    <>
      {(step.session ?? (queue.run?.step === step.id ? queue.run.session : undefined)) && (
        <Activity project={id} session={(step.session ?? queue.run?.session)!} queue={queue.id} step={step.id} version={project.generated_at} />
      )}
    </>
  );
  const commits = (
    <>
      <StepCommits project={id} queue={queue.id} step={step.id} version={project.generated_at} />
    </>
  );
  const timeline = (
    <>
      {step.timeline.length > 0 && (
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
      )}
    </>
  );
  const marked = pictures.filter((p) => step.pictures[p.item.path!]?.accepted).length;
  const others = step.review_items.filter((r) => !isImage(r));
  const reviewPictures = (
    <>
      {step.asked_user?.text && <p className="mt-4 text-sm text-fg"><span className="text-fg-3">{t("details.orchestratorAsks")} </span>{step.asked_user.text}</p>}
      {pictures.length > 0 && (
        <section className="mt-5">
          <div className="mb-2 flex items-baseline gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-3">{t("details.pictures", { count: pictures.length })}</h3>
            <span className="ml-auto text-xs text-fg-3">{marked ? <>{t("details.marked", { count: marked })} <span className="text-ok">✓</span></> : t("details.noneMarked")}</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {pictures.map(({ item: r, before }, n) => (
              <button key={r.path} onClick={() => nav.open(`viewer:${n}`)} className="group relative overflow-hidden rounded-lg border border-line bg-surface-2 text-left hover:border-fg-3/60">
                <img src={fileUrl(id, r.path!)} alt={r.label ?? ""} className="aspect-[16/10] w-full bg-canvas object-cover object-top" loading="lazy" />
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
            <a key={i} href={r.path ? fileUrl(id, r.path) : r.url!} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              {r.url ? "↗" : "▤"} {r.label ?? r.path ?? r.url}
            </a>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {latestChecks(step.checks).map((c, i) => <span key={i} title={c.summary} className={c.ok ? "text-ok" : "text-danger"}>{c.ok ? "✓" : "✗"} {c.name}{c.duration !== undefined && <span className="tabular-nums text-fg-3"> {formatSeconds(c.duration)}</span>}</span>)}
        {(step.goal || step.acceptance.length > 0 || step.review?.prepare) && <Fold label={t("details.goalAcceptance")} open={!!fold.goal} onToggle={() => setFold((f) => ({ ...f, goal: !f.goal }))} />}
        <StepCommits project={id} queue={queue.id} step={step.id} version={project.generated_at} toggle={{ open: !!fold.commits, onToggle: () => setFold((f) => ({ ...f, commits: !f.commits })) }} />
        {step.timeline.length > 0 && <Fold label={t("details.timeline")} open={!!fold.timeline} onToggle={() => setFold((f) => ({ ...f, timeline: !f.timeline }))} />}
      </div>
      {fold.goal && goalAcceptance}
      {fold.commits && commits}
      {fold.timeline && timeline}
    </>
  );
  // A provisional acceptance (review level 3): waiting for the user (Confirm, Fix it), confirmed, or a fix asked.
  const p = step.provisional;
  const provisionalBox = p && (
    <div className={`mb-5 rounded-lg border px-4 py-3 text-sm ${pendingProvisional(step) ? "border-review/40 bg-review/5" : "border-line"}`}>
      <p className="text-xs text-fg-3">{p.fix ? rich("provisional.fixAskedAt", { time: <TimeAgo key="t" at={p.fix.at} /> }) : p.confirmed ? rich("provisional.confirmedAt", { time: <TimeAgo key="t" at={p.confirmed} /> }) : rich("provisional.box", { time: <TimeAgo key="t" at={p.at} /> })}</p>
      {p.text && <p className="mt-1 text-fg"><span className="text-fg-3">{t("provisional.lookAt")} </span>{p.text}</p>}
      {p.fix && <p className="mt-1 text-fg">{p.fix.text}</p>}
      {pendingProvisional(step) && <>
        <p className="mt-1 text-xs text-fg-2">{t("provisional.boxHint")}</p>
        <div className="mt-2.5"><ProvisionalActions project={id} queue={queue.id} step={step.id} onDone={onChanged} wide /></div>
      </>}
    </div>
  );
  const body = reviewing ? (
    <>
      {summary}
      {reviewPictures}
      <div className="mt-6">{chat}</div>
      {retry}{push}{rejected}{sentBack}{message}{questionsPart}{statusNote}{notes}{messages}{refusals}{changes}{activity}{viewer}
    </>
  ) : (
    <>
      {provisionalBox}{chat}{retry}{summary}{reviewNotes}{push}{rejected}{sentBack}{message}{questionsPart}{statusNote}{goalAcceptance}{material}{viewer}
      {checks}{notes}{messages}{refusals}{changes}{activity}{commits}{timeline}
    </>
  );
  return (
    <>
      <PanelHeader
        where={phone
          ? <>{project.project.name} · {queue.id} · <span className="text-fg">{step.id}</span> {step.title}</>
          : <><span className="font-mono">{queue.id}</span> · {queue.title}</>}
        of={of} bare={questionFirst}
        title={<><span className="mr-2 font-mono text-fg-3">{step.id}</span>{step.title}</>}
        status={<>
          <StatusBadge status={pendingProvisional(step) ? "review" : step.status} label={reviewLabel(step) ?? provisionalWord(step)} />
          <span title={levelTitle(step.level)} className="inline-flex items-center gap-1">
            <LevelMark step={step} always />
            <span>{levelShort(step.level)}{step.level_from === "user" ? ` · ${t("level.setByYou")}` : ""}{project.away.on && step.level === 2 ? ` · ${t("level.awayAs3")}` : ""}</span>
          </span>
          <StepTimes step={step} />
          {step.commit && <span className="font-mono">{step.commit}</span>}
          {session && <span>{t("details.by", { session: session.title ?? session.id.slice(-8), runtime: session.runtime })}</span>}
          {stepValuesText(step) && (
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-fg" title={t("details.ownValuesTitle")}>
              {t("details.runsOn", { values: stepValuesText(step)! })}
            </span>
          )}
        </>}
        onClose={onClose}
      />
      {questionFirst
        ? <QuestionSheet key={asking!.qid} q={asking!} project={id} onChanged={onChanged}>{body}</QuestionSheet>
        : <PanelBody>{body}</PanelBody>}
      {questionFirst ? null : reviewing
        ? <ReviewBar key={step.id} project={id} queue={queue.id} step={step.id} next={noteTargets(queue.steps, step.id).next} criteria={step.acceptance} onChanged={onChanged} />
        : asking && <AnswerBar key={asking.qid} q={asking} project={id} onChanged={onChanged} />}
    </>
  );
}

/**
 * An option the user tapped in a waiting card, for the question's sheet to open with it chosen (the user confirms
 * there). Kept in memory until the sheet takes it.
 */
const chosen = new Map<string, string>();
export const chooseOption = (qid: string, option: string) => { chosen.set(qid, option); };

/**
 * A question's sheet on the phone: the question first (what kind, whether the worker waits, since when), what the
 * orchestrator said passing it on, the options as 48 px buttons, the user's own words, then the step's details
 * (`children`); Answer in the action bar. An option and words go together: the option, then the words.
 */
function QuestionSheet({ q, project, onChanged, children }: { q: QuestionView; project: string; onChanged: () => void; children: ReactNode }) {
  const [choice, setChoice] = useState<string | undefined>(() => { const c = chosen.get(q.qid); chosen.delete(q.qid); return c; });
  const [goOn, setGoOn] = useState(true);
  const d = useDraftText({
    draft: draftKey(project, "answer", q.qid), allowEmpty: true,
    onSubmit: async (words) => {
      const text = [choice, words].filter(Boolean).join(PARAGRAPH);
      if (!text) throw new Error(t("details.answer.empty"));
      await act(project, "POST", `/questions/${enc(q.qid)}/answer`, { text, continue: goOn });
      onChanged();
    },
  });
  const ready = !d.busy && (!!choice || !!d.text.trim());
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
        {!!q.options?.length && (
          <div className="mt-4 space-y-2.5" role="radiogroup" aria-label={t("details.question.options")}>
            {q.options.map((o, i) => (
              <button key={o} role="radio" aria-checked={choice === o} onClick={() => setChoice(choice === o ? undefined : o)}
                className={`flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-[15px] text-fg ${choice === o ? "border-accent bg-accent/10 ring-1 ring-accent" : "border-line-strong bg-surface-2 hover:bg-surface-3"}`}>
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs ${choice === o ? "bg-accent-strong text-on-accent" : "bg-surface-3 text-fg-2"}`}>{i + 1}</span>
                <span className="min-w-0 flex-1">{o}</span>
                {q.recommended === o && <span className="shrink-0 text-xs text-accent">{t("details.question.recommended")}</span>}
                {choice === o && <span className="shrink-0 text-xs text-accent">{q.recommended === o ? "· " : ""}{t("details.question.chosen")}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea value={d.text} rows={2} onChange={(e) => d.change(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (ready) void d.submit(); } }}
          placeholder={t(q.options?.length ? (choice ? "details.answer.addWords" : "details.answer.ownWords") : "details.answer.placeholder")}
          className={`mt-4 ${TEXTAREA}`} />
        <label className="mt-1 flex min-h-11 items-center gap-2 text-sm text-fg-2">
          <input type="checkbox" checked={goOn} onChange={(e) => setGoOn(e.target.checked)} className="h-4 w-4 accent-accent" />
          {t("details.answer.mayGoOn")}
        </label>
        <div className="mt-6 border-t border-line pt-4">{children}</div>
      </PanelBody>
      <ActionBar
        hint={d.error ? <span className="text-danger">{d.error}</span> : choice ? t(d.text.trim() ? "details.answer.answersWithWords" : "details.answer.answers", { option: choice }) : undefined}
        primary={<Button onClick={d.submit} disabled={!ready}>{d.busy ? t("ui.sending") : t("details.answer.button")}</Button>}
      />
    </>
  );
}

/** Between an option and the user's words in one answer. */
const PARAGRAPH = String.fromCharCode(10, 10);

/** Reject: the step is marked rejected, the run pauses, nothing is reverted; the orchestrator proposes what follows. */
function RejectStep({ project, queue, step, onChanged, onCancel }: { project: string; queue: string; step: string; onChanged: () => void; onCancel: () => void }) {
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reject = () => {
    setBusy(true); setError(undefined);
    act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/reject`, why.trim() ? { text: why } : {})
      .then(() => { onCancel(); setWhy(""); onChanged(); }, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="rounded-lg border border-danger/30 bg-danger/10 p-3">
      <p className="text-sm text-danger">{t("details.reject.title")}</p>
      <p className="mt-1 text-xs text-fg-2">{t("details.reject.text")}</p>
      <textarea
        value={why} rows={2} placeholder={t("details.reject.why")} onChange={(e) => setWhy(e.target.value)}
        className="mt-2 w-full resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 focus:border-danger focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={reject} className="rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/25 disabled:opacity-40">{t(busy ? "details.reject.busy" : "details.reject.button")}</button>
        <Button variant="quiet" onClick={onCancel}>{t("common.cancel")}</Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

/** A rejected step: by whom and why, and what the queue waits for while the rejection holds. */
function Rejected({ step, holding }: { step: StepView; holding: boolean }) {
  const at = step.timeline.findLast((e) => e.type === "review.rejected")?.at;
  return (
    <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm">
      <p>
        <span className="text-fg-3">{t(step.reason ? "details.rejected.byYouWhy" : "details.rejected.byYou")}</span>
        {step.reason && <span className="text-danger">{step.reason}</span>}
        {at && <span className="text-xs text-fg-3"> · <TimeAgo at={at} /></span>}
      </p>
      <p className="mt-1 text-xs text-fg-2">
        {t(holding ? "details.rejected.holding" : "details.rejected.newer")}
      </p>
    </div>
  );
}

/** A folded part of the review's one line: "▸ Goal and acceptance". */
function Fold({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-expanded={open} className="whitespace-nowrap text-fg-2 hover:text-fg max-lg:min-h-11">
      <span className={`mr-1 inline-block text-xs text-fg-3 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>{label}
    </button>
  );
}

/** On a picture's tile: accepted, its comments, whether it has a before to compare with. */
function PictureBadges({ marks, paired }: { marks?: StepView["pictures"][string]; paired: boolean }) {
  if (!marks?.accepted && !marks?.comments.length && !paired) return null;
  const chip = "rounded bg-canvas/70 px-1.5 py-0.5 text-[11px]";
  return (
    <span className="absolute right-1.5 top-1.5 flex gap-1">
      {paired && <span className={`${chip} text-fg`} title={t("details.hasBefore")}>⇄</span>}
      {marks?.accepted && <span className={`${chip} text-ok`} title={t("details.youMarkedAccepted")}>✓</span>}
      {!!marks?.comments.length && <span className={`${chip} text-info`} title={t("viewer.comments")}>💬 {marks.comments.length}</span>}
    </span>
  );
}

/**
 * The viewer's action bar (UX proposals, 14): for the picture on the left, its mark (a mark only; the step is not
 * accepted by it) and a one-line comment; for the step on the right, while it waits for the user's review, the same
 * decision as the drawer's bar (Accept, Fix it…, Reject and a note under ⋯), so the user decides after the last
 * picture without leaving the viewer. A comment goes back to the worker as a Fix it while the step waits for the user's
 * review; otherwise it is a note on the next pending step. The original file is under ⋯.
 */
function PictureActions({ project, queue, step, path, src, onChanged }: { project: string; queue: QueueView; step: StepView; path: string; src: string; onChanged: () => void }) {
  const marks = step.pictures[path];
  const [error, setError] = useState<string>();
  const next = noteTargets(queue.steps, step.id).next;
  const reviewing = showsReviewActions(step);
  const where = reviewing ? t("details.picture.toWorker")
    : step.status === "review" && step.review_with === "orchestrator" ? t("details.picture.toOrchestrator")
    : next ? t("details.picture.toNote", { step: next }) : undefined;
  const base = `/queues/${enc(queue.id)}/steps/${enc(step.id)}/pictures`;
  const comment = useDraftText({
    draft: draftKey(project, "picture", queue.id, step.id, path),
    onSubmit: async (text) => { await act(project, "POST", `${base}/comment`, { path, text }); onChanged(); },
  });
  const decision = useReviewDecision({ project, queue: queue.id, step: step.id, next, criteria: step.acceptance, onChanged }, t("details.acceptTheStep"));
  const original = { label: t("details.picture.original"), onSelect: () => window.open(src, "_blank", "noreferrer") };
  const phone = usePhone();
  const fail = error ?? comment.error ?? (reviewing ? decision.error : undefined);
  return (
    <ActionBar
      left={
        <div className="flex min-w-0 flex-1 basis-80 items-center gap-2">
          <button
            onClick={() => act(project, "POST", `${base}/mark`, { path, accepted: !marks?.accepted }).then(onChanged, (e: Error) => setError(e.message))}
            aria-pressed={!!marks?.accepted} title={t("details.picture.markTitle")}
            className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium max-lg:min-h-11 ${marks?.accepted ? "border-ok/50 bg-ok/20 text-ok" : "border-line-strong bg-surface-2 text-fg hover:bg-surface-3"}`}
          >{t(marks?.accepted ? "details.picture.marked" : "details.picture.mark")}</button>
          {where && (
            <input value={comment.text} onChange={(e) => comment.change(e.target.value)} aria-label={t("details.picture.commentLabel")}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void comment.submit(); } }}
              placeholder={t("details.picture.commentPlaceholder")} title={t("details.picture.commentTitle", { where })}
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none max-lg:min-h-11 lg:max-w-md" />
          )}
        </div>
      }
      hint={fail ? <span className="text-danger">{fail}</span> : reviewing && !phone ? <span className="block text-right">{t("details.picture.theStep")}</span> : undefined}
      menu={reviewing ? [...decision.menu, original] : [original]}
      secondary={reviewing ? decision.secondary : undefined}
      primary={reviewing ? decision.primary : undefined}
    >
      {(reviewing && decision.forms) || marks?.comments.length ? (
        <div className="space-y-3 text-sm">
          {reviewing && decision.forms}
          {!!marks?.comments.length && (
            <div className="space-y-1.5">
              {marks.comments.map((c, i) => (
                <div key={i} className="rounded-md bg-surface-3 px-2 py-1.5">
                  <p className="whitespace-pre-wrap text-fg">{c.text}</p>
                  <p className="text-[11px] text-fg-3">{c.to === "send_back" ? t("details.comment.sentBack") : c.to === "orchestrator" ? t("details.comment.toOrchestrator") : t("details.comment.note", { step: c.note_step ?? "" })} · <TimeAgo at={c.at} /></p>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : undefined}
    </ActionBar>
  );
}

interface CommitView { sha: string; subject: string; author: string; at: string; files: number; insertions: number; deletions: number; foreign: boolean }
interface RoundView { session: string; start: string | null; end: string | null; open: boolean; commits: CommitView[] }

/** The commits of each round of the step (server: src/gitinfo.ts); nothing outside a git repository. */
function StepCommits({ project, queue, step, version, toggle }: {
  project: string; queue: string; step: string; version: unknown;
  /** The review's one line: "Commits · 3", which opens and closes the list. */
  toggle?: { open: boolean; onToggle: () => void };
}) {
  const data = useFetch<{ rounds: RoundView[] } | null>(`/api/projects/${enc(project)}/queues/${enc(queue)}/steps/${enc(step)}/commits`, version);
  if (!data) return null;
  if (toggle) {
    const n = data.rounds.reduce((k, r) => k + r.commits.length, 0);
    return <Fold label={t("details.commitsCount", { count: n })} open={toggle.open} onToggle={toggle.onToggle} />;
  }
  const several = data.rounds.length > 1;
  const foreign = data.rounds.some((r) => r.commits.some((c) => c.foreign));
  return (
    <Section title={t("details.commits")} aside={foreign ? <span className="text-xs text-warn/80">◆ {t("details.commits.foreign")}</span> : undefined}>
      <div className="space-y-3">
        {data.rounds.map((r, i) => (
          <div key={i}>
            {several && <div className="mb-1 text-xs text-fg-3">{t(r.open ? "details.commits.roundAtWork" : "details.commits.round", { round: i + 1 })}</div>}
            {r.commits.length === 0
              ? <p className="text-sm text-fg-3">{t(r.open ? "details.commits.noneYet" : "details.commits.none")}</p>
              : (
                <ul className="space-y-1.5">
                  {r.commits.map((c) => (
                    <li key={c.sha} className="text-sm">
                      <div className="flex gap-2">
                        <span className="shrink-0 font-mono text-xs leading-5 text-fg-3">{c.sha.slice(0, 7)}</span>
                        <span className={`min-w-0 ${c.foreign ? "text-warn" : "text-fg"}`}>{c.foreign && <span className="text-warn" title={t("details.commits.foreignTitle")}>◆ </span>}{c.subject}</span>
                      </div>
                      <div className="pl-[3.75rem] text-xs text-fg-3">
                        {t("stop.files", { count: c.files })} · <span className="text-ok/80">+{c.insertions}</span> <span className="text-danger/80">−{c.deletions}</span> · {c.author} · <TimeAgo at={c.at} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        ))}
      </div>
    </Section>
  );
}

/**
 * A finished queue with a worktree of its own: merge its branch back into its base, and clean up (the worktree removed,
 * the branch deleted with -d). The user's only; each asks first and tells what it will do.
 */
function WorktreeActions({ project, root, queue, onChanged }: { project: string; root: string; queue: QueueView; onChanged: () => void }) {
  const [ask, setAsk] = useState<"merge" | "cleanup">();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const g = queue.git;
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  if (!queue.worktree || queue.worktree === "auto" || norm(queue.worktree) === norm(root)) return null;
  if (queue.status !== "done" && !g?.merged && !g?.cleaned) return null;
  const branch = queue.branch ?? t("details.worktree.itsBranch");
  const base = g?.base?.branch !== false ? g?.base?.ref : undefined;
  const go = (what: "merge" | "cleanup") => {
    setBusy(true); setResult(undefined);
    fetch(`/api/projects/${enc(project)}/queues/${enc(queue.id)}/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then(async (r) => { const b = await r.json().catch(() => ({})) as { result?: { message?: string }; error?: string }; setResult(r.ok ? { ok: true, text: b.result?.message ?? t("details.worktree.done") } : { ok: false, text: b.error ?? r.statusText }); if (r.ok) setAsk(undefined); onChanged(); })
      .catch((e: Error) => setResult({ ok: false, text: e.message }))
      .finally(() => setBusy(false));
  };
  return (
    <Section title={t("details.worktree")}>
      <p className="break-all text-xs text-fg-3">{rich(g?.base ? "details.worktree.onFrom" : "details.worktree.on", {
        path: <span key="path" className="font-mono">{queue.worktree}</span>, branch: <span key="branch" className="font-mono">{branch}</span>,
        base: <span key="base" className="font-mono">{g?.base?.ref}</span>,
      })}</p>
      {g?.merged && <p className="mt-1.5 text-sm text-ok">{rich("details.worktree.merged", {
        into: <span key="into" className="font-mono">{g.merged.into}</span>,
        how: g.merged.fast_forward ? t("details.worktree.fastForward") : t("details.worktree.mergeCommit", { sha: g.merged.sha.slice(0, 7) }),
      })} <span className="text-xs text-fg-3">· <TimeAgo at={g.merged.at} /></span></p>}
      {g?.cleaned
        ? <p className="mt-1.5 text-sm text-fg">{rich("details.worktree.cleaned", { branch: <span key="branch" className="font-mono">{g.cleaned.branch}</span> })} <span className="text-xs text-fg-3">· <TimeAgo at={g.cleaned.at} /></span></p>
        : (
          <div className="mt-2 flex flex-wrap gap-2">
            {base && !g?.merged && <Button variant="quiet" onClick={() => { setAsk("merge"); setResult(undefined); }}>{t("details.worktree.mergeInto", { base: base ?? "" })}</Button>}
            <Button variant="quiet" onClick={() => { setAsk("cleanup"); setResult(undefined); }}>{t("details.worktree.cleanUpAsk")}</Button>
          </div>
        )}
      {ask && !g?.cleaned && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3">
          {ask === "merge" ? (
            <>
              <p className="text-sm text-warn">{rich("details.worktree.mergeQuestion", { branch: <span key="branch" className="font-mono">{branch}</span>, base: <span key="base" className="font-mono">{base}</span> })}</p>
              <p className="mt-1 text-xs text-fg-2">{t("details.worktree.mergeText", { base: base ?? "" })}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-warn">{t("details.worktree.cleanUpQuestion")}</p>
              <p className="mt-1 text-xs text-fg-2">{rich("details.worktree.cleanUpText", { branch: <span key="branch" className="font-mono">{branch}</span> })}</p>
            </>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => go(ask)}>{t(busy ? "details.worktree.working" : ask === "merge" ? "details.worktree.merge" : "details.worktree.cleanUp")}</Button>
            <Button variant="quiet" onClick={() => setAsk(undefined)}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}
      {result && <p className={`mt-2 break-all text-xs ${result.ok ? "text-ok" : "text-danger"}`}>{result.text}</p>}
    </Section>
  );
}

interface BranchView { branch: string; base?: { ref: string; ahead: number; behind: number }; upstream?: { ref: string; ahead: number; behind: number; at?: string } }

/** The queue's branch: ahead and behind of its base and of its remote-tracking ref (as last fetched: never fetched here). */
function BranchLine({ project, queue, version }: { project: string; queue: string; version: unknown }) {
  const b = useFetch<BranchView | null>(`/api/projects/${enc(project)}/queues/${enc(queue)}/git`, version);
  if (!b) return null;
  const counts = (x: { ahead: number; behind: number }) => (
    <span><span className="text-ok">{t("details.branch.ahead", { count: x.ahead })}</span>, <span className={x.behind ? "text-warn" : "text-fg-2"}>{t("details.branch.behind", { count: x.behind })}</span></span>
  );
  return (
    <div className="mt-3 space-y-0.5 rounded-lg bg-surface-2 p-3 text-sm text-fg">
      <p><span className="text-fg-3">{t("details.branch")} </span><span className="font-mono">{b.branch}</span></p>
      {b.base && <p className="text-xs">{counts(b.base)} <span className="text-fg-3">{t("details.branch.ofBase")}</span> <span className="font-mono">{b.base.ref}</span></p>}
      {b.upstream
        ? <p className="text-xs">{counts(b.upstream)} <span className="text-fg-3">{t("details.branch.of")}</span> <span className="font-mono">{b.upstream.ref}</span> <span className="text-fg-3">{b.upstream.at ? rich("details.branch.fetched", { time: <TimeAgo key="time" at={b.upstream.at} /> }) : t("details.branch.fetchedUnknown")}</span></p>
        : <p className="text-xs text-fg-3">{t("details.branch.noUpstream")}</p>}
    </div>
  );
}

/** What became of pushing an accepted step: pushed, not pushed (no remote), or failed with Push again. */
function PushLine({ project, queue, step, onChanged }: { project: string; queue: QueueView; step: string; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const p = queue.push?.steps[step];
  if (!p) return null;
  const failed = p.result === "failed";
  const latest = failed && queue.push?.error?.step === step;
  return (
    <div className={`mt-4 rounded-lg border p-3 text-sm ${failed ? "border-danger/30 bg-danger/10" : p.result === "pushed" ? "border-ok/30 bg-ok/10" : "border-line-strong bg-surface-2"}`}>
      <p>
        <span className="text-fg-3">{t(failed ? "details.push.failed" : p.result === "pushed" ? "details.push.pushed" : "details.push.push")} </span>
        <span className={failed ? "text-danger" : "text-fg"}>{p.text}</span>
        <span className="text-xs text-fg-3"> · <TimeAgo at={p.at} /></span>
      </p>
      {failed && <p className="mt-1 text-xs text-fg-2">{t("details.push.failedText")}</p>}
      {latest && (
        <div className="mt-2 flex items-center gap-3">
          <Button variant="quiet" disabled={busy} onClick={() => { setBusy(true); setError(undefined); act(project, "POST", `/queues/${enc(queue.id)}/push`).then(onChanged, (e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>{t(busy ? "details.push.busy" : "details.push.again")}</Button>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      )}
    </div>
  );
}

interface ReviewArgs { project: string; queue: string; step: string; next?: string; criteria: string[]; onChanged: () => void }

/**
 * The user's decision on a step in their review, for an action bar: Accept (with a note, under ⋯), Fix it… beside it,
 * Reject under ⋯, and the forms they open. Fix it opens with the text kept from before, if there is one. The step's
 * drawer and the picture viewer each show it (`accept` names the button).
 */
function useReviewDecision({ project, queue, step, next, criteria, onChanged }: ReviewArgs, accept_label: string) {
  const [error, setError] = useState<string>();
  // Accept's note: closed by default; empty means a plain accept. It goes to the next step, or to the orchestrator
  // (always on the queue's last step).
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteTo, setNoteTo] = useState<"next" | "orchestrator">("next");
  const to = next ? noteTo : "orchestrator";
  const accept = () => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/accept`, note.trim() ? { text: note, note_to: to } : {})
    .then(() => { setNote(""); setNoteOpen(false); onChanged(); }, (e: Error) => setError(e.message));
  const [fixOpen, setFixOpen] = useState(() => !!readDraft(draftKey(project, "fix", queue, step)));
  const [rejectOpen, setRejectOpen] = useState(false);
  // Fix it with criteria: the text waits here until the user confirms that it overrides them.
  const [confirm, setConfirm] = useState<{ resolve: () => void; reject: (e: Error) => void; send: () => Promise<void> }>();
  const send = (text: string) => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/send-back`, { text }).then(onChanged);
  const menu: MenuEntry[] = [
    ...(noteOpen ? [] : [{ label: t("details.review.addNote"), onSelect: () => setNoteOpen(true) }]),
    ...(rejectOpen ? [] : [{ label: t("details.review.reject"), danger: true, onSelect: () => setRejectOpen(true) }]),
  ];
  const opened = noteOpen || fixOpen || rejectOpen;
  return {
    error,
    menu,
    secondary: <Button variant="quiet" pressed={fixOpen} onClick={() => setFixOpen(!fixOpen)}>{t("details.review.fixOpen")}</Button>,
    primary: <Button onClick={() => void accept()}>{note.trim() ? t("details.review.acceptWithNote") : accept_label}</Button>,
    forms: opened && <div className="space-y-4">
      {rejectOpen && <RejectStep project={project} queue={queue} step={step} onChanged={onChanged} onCancel={() => setRejectOpen(false)} />}
      {noteOpen && (
        <div>
          <textarea
            value={note} rows={2} placeholder={t("details.review.notePlaceholder")} onChange={(e) => setNote(e.target.value)}
            className={TEXTAREA}
          />
          {next ? (
            <label className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-fg-2">
              {t("details.review.noteGoesTo")}
              <select value={noteTo} onChange={(e) => setNoteTo(e.target.value as "next" | "orchestrator")} className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-fg">
                <option value="next">{t("details.review.toNext", { step: next })}</option>
                <option value="orchestrator">{t("details.review.toOrchestrator")}</option>
              </select>
            </label>
          ) : (
            <p className="mt-1.5 text-xs text-fg-2">{t("details.review.lastStep")}</p>
          )}
        </div>
      )}
      {fixOpen && <div>
        <p className="mb-1.5 text-sm text-fg">{t("details.review.fix")}</p>
        <p className="mb-2 text-xs text-fg-3">{t("details.review.fixText")}</p>
        <Composer
          draft={draftKey(project, "fix", queue, step)}
          placeholder={t("details.review.fixPlaceholder")}
          button={t("details.review.fix")}
          verbatim
          onSubmit={(text) => criteria.length
            ? new Promise<void>((resolve, reject) => setConfirm({ resolve, reject, send: () => send(text) }))
            : send(text)}
        />
        {confirm && (
          <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3">
            <p className="text-sm text-warn">{t("details.review.override")}</p>
            <ul className="mt-1.5 space-y-1">
              {criteria.map((c, i) => <li key={i} className="flex gap-2 text-sm text-fg"><span className="text-fg-3">◇</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => { const c = confirm; setConfirm(undefined); c.send().then(c.resolve, c.reject); }}>{t("details.review.sendBack")}</Button>
              <Button variant="quiet" onClick={() => { const c = confirm; setConfirm(undefined); c.reject(new Error(t("details.review.notSent"))); }}>{t("common.cancel")}</Button>
            </div>
          </div>
        )}
      </div>}
      </div>,
  };
}

/** The bar of a step in the user's review: Accept and go on, Fix it… beside it, Reject and a note under ⋯. */
function ReviewBar(props: ReviewArgs) {
  const d = useReviewDecision(props, t("details.review.acceptGoOn"));
  return (
    <ActionBar hint={d.error ? <span className="text-danger">{d.error}</span> : undefined} menu={d.menu} secondary={d.secondary} primary={d.primary}>
      {d.forms}
    </ActionBar>
  );
}

/** The bar of a step with an open question: the answer box, whether the worker may go on, and Answer. */
function AnswerBar({ q, project, onChanged }: { q: QuestionView; project: string; onChanged: () => void }) {
  const [goOn, setGoOn] = useState(true);
  const d = useDraftText({
    draft: draftKey(project, "answer", q.qid),
    onSubmit: async (text) => { await act(project, "POST", `/questions/${enc(q.qid)}/answer`, { text, continue: goOn }); onChanged(); },
  });
  return (
    <ActionBar
      hint={d.error ? <span className="text-danger">{d.error}</span> : t("details.answer.ctrlEnter")}
      primary={<Button onClick={d.submit} disabled={!d.ready}>{d.busy ? t("ui.sending") : t("details.answer.button")}</Button>}
    >
      <textarea value={d.text} rows={2} placeholder={t("details.answer.placeholder")} onChange={(e) => d.change(e.target.value)} onKeyDown={d.onKeyDown} className={TEXTAREA} />
      <label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-2">
        <input type="checkbox" checked={goOn} onChange={(e) => setGoOn(e.target.checked)} className="accent-accent" />
        {t("details.answer.mayGoOn")}
      </label>
    </ActionBar>
  );
}

function WithdrawNote({ project, queue, step, note, onChanged }: { project: string; queue: string; step: string; note: string; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  return (
    <>
      {error && <span className="text-danger">{error}</span>}
      <button
        className="text-fg-3 hover:text-danger"
        onClick={() => act(project, "DELETE", `/queues/${enc(queue)}/steps/${enc(step)}/notes/${enc(note)}`).then(onChanged, (e: Error) => setError(e.message))}
      >{t("details.note.withdraw")}</button>
    </>
  );
}

function describe(e: Event): string {
  switch (e.type) {
    case "step.progress": return e.text + (e.pct !== undefined ? ` (${e.pct}%)` : "");
    case "step.done": return e.summary;
    case "step.failed": return e.reason;
    case "queue.stop": return `${e.condition}: ${e.reason}`;
    case "check.result": return `${e.ok ? "✓" : "✗"} ${e.name}${e.duration !== undefined ? ` (${formatSeconds(e.duration)})` : ""}${e.summary ? ` — ${e.summary}` : ""}`;
    case "review.added": return e.items.map((i) => i.label ?? i.path ?? i.url).join(", ");
    case "question.asked": return e.text;
    case "answer.given": return e.text;
    case "context.summary": return e.text.slice(0, 200);
    case "review.accepted": return e.text ?? "";
    case "review.sent_back": return e.text;
    case "review.asked_user": return e.text;
    case "review.rejected": return e.text ?? "";
    case "review.provisional": return e.text ?? "";
    case "review.fix_asked": return e.text;
    default: return "";
  }
}

/** A question and its answers; open, with its answer box, unless the panel's action bar answers it (`inBar`). */
export function Question({ q, project, onChanged, inBar }: { q: QuestionView; project: string; onChanged: () => void; inBar?: boolean }) {
  const open = q.state === "open" || q.state === "escalated";
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
      {q.options && (
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
          <AnswerBox q={q} project={project} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

function AnswerBox({ q, project, onChanged }: { q: QuestionView; project: string; onChanged: () => void }) {
  const [goOn, setGoOn] = useState(true);
  return (
    <Composer
      rows={2}
      draft={draftKey(project, "answer", q.qid)}
      placeholder={t("details.answer.placeholder")}
      button={t("details.answer.button")}
      extra={
        <label className="flex items-center gap-1.5 text-xs text-fg-2">
          <input type="checkbox" checked={goOn} onChange={(e) => setGoOn(e.target.checked)} className="accent-accent" />
          {t("details.answer.mayGoOn")}
        </label>
      }
      onSubmit={async (text) => { await act(project, "POST", `/questions/${enc(q.qid)}/answer`, { text, continue: goOn }); onChanged(); }}
    />
  );
}

// ---------------------------------------------------------------- queue

const WHO: Record<StatusChange["by"], Key> = { user_approval: "details.change.byApproval", user_continue: "details.change.byContinue", orchestrator: "details.change.byOrchestrator", nexus: "details.change.byNexus" };

const QUESTION_STATES: Record<string, Key> = { open: "details.question.stateOpen", answered: "details.question.stateAnswered", withdrawn: "details.question.stateWithdrawn" };
/** A question's state as a word; one the dashboard does not know, as it is. */
const questionState = (state: string) => (QUESTION_STATES[state] ? t(QUESTION_STATES[state]) : state);

/** Status changes made through Nexus (queue.yaml's changes): who, when, what and why; newest first. */
function Changes({ entries, queue }: { entries: StatusChange[]; queue: QueueView }) {
  if (!entries.length) return null;
  const what = (c: StatusChange) => {
    switch (c.kind) {
      case "lift": return c.revision ? t("details.change.liftedRevision", { revision: c.revision }) : t("details.change.lifted");
      case "proposal": return t("details.change.proposal");
      case "run": return t("details.change.run");
      case "work": return t(c.to === "kept" ? "details.change.kept" : "details.change.discarded", { step: c.step ?? "", count: c.commits?.length ?? 0 });
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
function WithdrawApproval({ project, queue, onChanged, onCancel }: { project: string; queue: string; onChanged: () => void; onCancel: () => void }) {
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

export function QueueDetail({ project, queue, onChanged, onClose, of, chat = [], onFull }: Props) {
  const id = project.project.id;
  const latest = queue.approvals.at(-1);
  const inherited = project.project.defaults.stop_conditions;
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
  const history = [...queue.approvals.map((a) => ({ ...a, withdrawn: false as const })), ...queue.withdrawals.map((w) => ({ ...w, withdrawn: true as const }))]
    .sort((x, y) => x.at.localeCompare(y.at));

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
            {t(queue.approved ? "details.approval.approved" : queue.withdrawals.length && queue.withdrawals.at(-1)!.approvals >= queue.approvals.length ? "details.approval.withdrawn" : latest ? "details.approval.older" : "details.approval.none")}
          </span>
        </>}
        onClose={onClose}
      />
      <PanelBody>
      <BranchLine project={id} queue={queue.id} version={project.generated_at} />
      <WorktreeActions project={id} root={project.project.root} queue={queue} onChanged={onChanged} />

      {queue.status === "stopped"
        ? <StopBox queue={queue} left={left ?? undefined} work={work} setWork={setWork} needsChoice={needsChoice} pushAccepted={project.project.defaults.push_accepted} />
        : queue.status_reason && <Section title={t("details.state")}><Expandable text={queue.status_reason} /></Section>}
      {approving && <CompactSteps project={project} queue={queue} chat={chat} onFull={onFull} onChanged={onChanged} />}
      {queue.report && (
        <Section title={t("details.report")}>
          <p className="text-sm text-fg">{queue.report.summary}</p>
          <a className="text-sm text-accent underline" href={fileUrl(id, queue.report.path)} target="_blank" rel="noreferrer">{t("details.openReport")}</a>
        </Section>
      )}
      {queue.questions.length > 0 && <Section title={t("details.questions")}>{queue.questions.map((q) => <Question key={q.qid} q={q} project={id} onChanged={onChanged} />)}</Section>}

      {!approving && <OwnValues queue={queue} />}

      {history.length > 0 && <Section title={t("details.approval")}>
        {history.map((a, i) => (
            <p key={i} className={`mb-1 text-sm ${a.withdrawn ? "text-stop/90" : "text-fg"}`}>
              {t("details.approval.revision", { revision: a.revision })} · {a.withdrawn ? `${t("details.approval.withdrawnAt")} ` : ""}<TimeAgo at={a.at} />
              {!a.withdrawn && a.words && <> · <q className="italic">{a.words}</q></>}
              {a.withdrawn && a.reason && <> · <q className="italic">{a.reason}</q></>}
            </p>
          ))}
      </Section>}

      <RunControls project={project} queue={queue} onChanged={onChanged} />

      <Changes entries={queue.changes} queue={queue} />

      {!approving && queue.description && <Section title={t("approval.description")}><Expandable text={queue.description} lines={6} /></Section>}

      {!approving && <Section title={t("approval.stopConditions")}>
        <ul className="space-y-1.5 text-sm text-fg">
          {queue.stop_conditions.map((c, i) => <li key={i} className="flex gap-2"><span className="text-stop/70">■</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
          {inherited.map((c, i) => <li key={`p${i}`} className="flex gap-2 text-fg-3"><span>□</span><span>{c} <span className="text-xs">{t("approval.fromProject")}</span></span></li>)}
          {queue.stop_conditions.length + inherited.length === 0 && <li className="text-fg-3">{t("approval.none")}</li>}
        </ul>
      </Section>}
      {!approving && queue.checks.length > 0 && (
        <Section title={t("approval.checks")}>
          {queue.checks.map((c, i) => <Markdown key={i}>{c}</Markdown>)}
        </Section>
      )}
      {queue.source && (
        <p className="mt-6 text-xs text-fg-3">{rich("details.imported", { path: <span key="path" className="font-mono">{queue.source.path}</span>, time: <TimeAgo key="time" at={queue.source.imported_at} /> })}</p>
      )}
      </PanelBody>
      <QueueBar key={queue.id} project={project} queue={queue} onChanged={onChanged} left={leftState} work={work} needsChoice={needsChoice} />
    </>
  );
}

/**
 * The bar of a queue: Continue on a stopped queue whose revision is approved; Approve revision N (words with it under
 * ⋯) on one that is not; Withdraw approval (a queue approved but never started) and the review policy under ⋯.
 */
function QueueBar({ project, queue, onChanged, left, work, needsChoice }: {
  project: ProjectState; queue: QueueView; onChanged: () => void; left: LeftState; work?: WorkChoice; needsChoice: boolean;
}) {
  const id = project.project.id;
  const stopped = queue.status === "stopped";
  // A stop's buttons and hint, as everywhere the stop is shown; Continue itself is the one in Stop.tsx.
  const d = stopped ? stopDecision({ approved: queue.approved, revision: queue.revision, left, work }) : undefined;
  const cont = useContinue({ project: id, queue: queue.id, onChanged });
  // Continue may skip the queue's closing refactoring step while it has not run (the user's choice, not an agent's).
  const closing = queue.steps.find((s) => s.closing);
  const canSkipClosing = stopped && queue.approved && !!closing && (closing.status === "pending" || closing.status === "stopped");
  const [skipClosing, setSkipClosing] = useState(false);
  // The approval (Approval.tsx, the same in the full view): its words, Keep or Discard, what it pins; Ctrl+Enter.
  const a = useApprove({ project: id, queue, left, work, onChanged });
  useCtrlEnter(!queue.approved, a.submit);
  const [error, setError] = useState<string>();
  const canWithdraw = queue.approved && !queue.run && queue.steps.every((s) => s.status === "pending" && s.segments.length === 0);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const setLevel = (review_level: number | null) =>
    act(id, "PATCH", `/queues/${enc(queue.id)}`, { review_level }).then(onChanged, (e: Error) => setError(e.message));
  const projectDefault = t("details.level.projectDefault", { level: levelWords(project.project.defaults.review_level) });
  const policy = queue.review_level ? levelWords(queue.review_level) : projectDefault;

  const menu: MenuEntry[] = [
    ...(!queue.approved ? a.menu : []),
    ...(canWithdraw && !withdrawOpen ? [{ label: t("details.withdraw.menu"), danger: true, onSelect: () => setWithdrawOpen(true) }] : []),
    ...(!policyOpen ? [{ label: t("details.level.menu", { level: policy }), onSelect: () => setPolicyOpen(true) }] : []),
  ];
  const fail = cont.error ?? error ?? a.words.error;
  const said = cont.note ?? a.note;
  const hint = fail ? <span className="text-danger">{fail}</span>
    : said ? <span className="text-info">{said}</span>
    : stopped && queue.approved ? d!.hint
    : !queue.approved ? a.hint
    : undefined;
  const primary = stopped && queue.approved
    ? d!.confirm && <Button disabled={cont.busy || d!.confirm.disabled} onClick={() => void cont.go(d!.needsChoice, work, canSkipClosing && skipClosing)}>{d!.confirm.label}</Button>
    : !queue.approved
      ? <Button disabled={a.disabled} onClick={a.submit}>{a.label}</Button>
      : undefined;
  const opened = (!queue.approved && a.wordsOpen) || (canWithdraw && withdrawOpen) || policyOpen;
  return (
    <ActionBar hint={hint} menu={menu} secondary={!queue.approved && <AskButton project={id} queue={queue} />} primary={primary}
      left={canSkipClosing && (
        <label className="flex items-center gap-2 text-sm text-fg max-lg:min-h-11">
          <input type="checkbox" checked={skipClosing} onChange={(e) => setSkipClosing(e.target.checked)} className="accent-accent" />
          {t("stop.skipClosing")}
        </label>
      )}>
      {opened && (
        <div className="space-y-4">
          {!queue.approved && a.wordsBox}
          {canWithdraw && withdrawOpen && <WithdrawApproval project={id} queue={queue.id} onChanged={onChanged} onCancel={() => setWithdrawOpen(false)} />}
          {policyOpen && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
              <label className="flex flex-wrap items-center gap-2">
                {t("details.level.label")}
                <select
                  value={queue.review_level ?? ""}
                  onChange={(e) => void setLevel(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm"
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
