// A step's panel: its header (status, level, times, who works on it) and its parts in order; Accept, Answer or the
// question's sheet in its action bar. The parts are in stepParts.tsx; what it shows in which form is decided in
// details.ts (stepLayout).
import { stepValuesText } from "@nexus/protocol/steps";
import { useEffect, useRef } from "react";
import { fileUrl, type StepView } from "../../api.ts";
import { shownPicture, stepLayout, stepPictures } from "../../details.ts";
import { t } from "../../i18n.ts";
import { layerValue } from "../../layers.ts";
import { nav, useNav } from "../../nav.ts";
import { usePhone } from "../../phone.ts";
import { noteTargets } from "../../review.ts";
import { StepChat } from "../Chat.tsx";
import { QuestionWait } from "../QuestionWait.tsx";
import { StepSwitches } from "../Fallback.tsx";
import { LevelMark, LevelPicker, acceptedWord, levelChangeable, levelShort, levelTitle, pendingProvisional, provisionalWord } from "../Levels.tsx";
import { StepRefusals } from "../Refusals.tsx";
import { Activity } from "../Run.tsx";
import { stepMetrics } from "../../metrics.ts";
import { StepTags } from "../Tags.tsx";
import { PanelBody, PanelHeader, Section, StatusBadge, StepTimes, stepLabel } from "../ui.tsx";
import { continuedShort } from "../../steplist.ts";
import { checkTone } from "../../checks.ts";
import { ImageViewer } from "../Viewer.tsx";
import { IntegrationBox, PushLine, StepCommits } from "./git.tsx";
import type { PanelProps } from "./props.ts";
import { Changes } from "./QueueDetail.tsx";
import { Question, QuestionSheet } from "./questions.tsx";
import { PictureActions, Rejected, ReviewBar } from "./review.tsx";
import { DecisionList, useStepDecisions } from "./decisions.tsx";
import {
  CheckRunBox, ContinuedBox, GoalAcceptance, Material, MessageAgent, Messages, Notes, ProvisionalBox, RetryLine, ReviewNotes, ReviewPictures, SentBack, StatusNote, StepChecks, StepMetrics,
  Summary, Timeline,
} from "./stepParts.tsx";

export function StepDetail({ project, queue, step, onClose, of, qid }: PanelProps & { step: StepView; qid?: string }) {
  const id = project.project.id;
  const questions = queue.questions.filter((q) => q.step === step.id);
  const phone = usePhone();
  // A step of a finished or cancelled queue is only read: no level, note, message, review or answer (details.ts).
  const { readOnly, live, forOrchestrator, notesOpen, orchestratorAsks, reviewing, asking, questionFirst } = stepLayout(step, questions, phone, queue, qid);
  const selected = qid ? questions.find((q) => q.qid === qid) : undefined;
  // On the desktop a linked question (#/…/<step>/<qid>) comes into view, with the step's wait line above it.
  const questionTop = useRef<HTMLDivElement>(null);
  const waiting = <QuestionWait queue={queue} step={step.id} />;
  useEffect(() => {
    if (!phone && qid) questionTop.current?.scrollIntoView({ block: "start" });
  }, [id, qid, phone]);
  const session = live ? project.sessions.find((s) => s.id === step.session) : undefined;
  // Review images open in the in-app viewer, a layer above the step (Back closes it); other items as links.
  const { pairs, images } = stepPictures(step, (path) => fileUrl(id, path));
  const shown = shownPicture(layerValue(useNav(), "viewer"), images.length);
  const writes = { project: id, queue, step };
  // A decision's material (queue RVD): a picture's view key or path opens the viewer on it; another item, its file.
  const material = (m: string) => {
    const at = pairs.findIndex((p) => p.item.path === m || p.item.key === m);
    if (at >= 0) {
      const item = pairs[at]!.item;
      const many = !!item.key && item.key === m && pairs.filter((p) => p.item.key === m).length > 1;
      return { label: many || !item.label ? m : item.label, open: () => nav.open(`viewer:${at}`) };
    }
    const other = step.review_items.find((r) => r.path === m || r.url === m);
    if (!other) return undefined;
    return { label: other.label ?? m, open: () => window.open(other.url ?? fileUrl(id, other.path!), "_blank", "noreferrer") };
  };
  const decisions = useStepDecisions(id, queue, step);
  // In review the user answers (also while the orchestrator holds it: the user's answer counts whoever reviews); after
  // it, the answers are only shown.
  const decisionsPart = <DecisionList project={id} queue={queue} step={step} decisions={decisions} material={material} readOnly={readOnly || step.status !== "review"} />;

  // The step's parts. While it waits for the user's review the summary and the pictures come first (UX proposals,
  // 13 and 14); otherwise the usual order.
  const chat = <StepChat project={id} queue={queue.id} step={step.id} />;
  const retry = <><RetryLine queue={queue} step={step} /><CheckRunBox project={id} queue={queue} step={step} /></>;
  const summary = <Summary queue={queue} step={step} />;
  const push = <PushLine project={id} queue={queue} step={step.id} />;
  const rejected = step.status === "rejected" && <Rejected step={step} holding={queue.rejection?.step === step.id} />;
  const message = live && session && <MessageAgent {...writes} session={session} />;
  const others = questions.filter((q) => q.qid !== selected?.qid && !(questionFirst && q.qid === asking?.qid));
  const questionsPart = others.length > 0 && (
    <Section title={t(questionFirst ? "details.otherQuestions" : "details.questions")}>
      {others.map((q) => <Question key={`${id}/${q.qid}`} q={q} project={id} readOnly={readOnly} />)}
    </Section>
  );
  const switches = <StepSwitches queue={queue} step={step.id} />;
  const viewer = shown !== undefined && images.length > 0 && (
    <ImageViewer images={images} index={shown} onIndex={(i) => nav.open(`viewer:${i}`)} onClose={() => nav.close("viewer")}
      back={step.id} context={`${project.project.name} · ${queue.id} · ${step.id} ${step.title}`}
      footer={readOnly ? undefined : (i) => <PictureActions key={pairs[i]!.item.path} project={id} queue={queue} step={step} path={pairs[i]!.item.path!} src={images[i]!.src} material={material} />} />
  );
  const notes = (!readOnly || step.notes.length > 0) && <Notes {...writes} forOrchestrator={forOrchestrator} notesOpen={notesOpen} readOnly={readOnly} />;
  const refusals = <StepRefusals project={project} queue={queue.id} step={step.id} />;
  const changes = <Changes entries={queue.changes.filter((c) => c.step === step.id)} queue={queue} />;
  // Its own session, or the run's while the run is at this step.
  const activitySession = step.session ?? (queue.run?.step === step.id ? queue.run.session : undefined);
  const activity = activitySession && <Activity project={id} session={activitySession} queue={queue.id} step={step.id} />;
  const integration = step.integration ? <IntegrationBox project={project} queue={queue} step={step} /> : <ContinuedBox project={project} queue={queue} step={step} />;
  // Its metrics whose latest value is beyond the threshold: said in the header too, so a review sees it at once.
  const warned = stepMetrics(step.metrics).filter((m) => m.warn).length;
  const accepted = acceptedWord(step);
  const body = reviewing ? (
    <>
      {decisionsPart}
      {integration}
      {summary}
      <StepTags step={step} />
      <StepMetrics step={step} />
      <ReviewPictures project={id} queue={queue} step={step} pairs={pairs} orchestratorAsks={orchestratorAsks} />
      <div className="mt-6">{chat}</div>
      {retry}{switches}{push}{rejected}<SentBack step={step} />{message}{questionsPart}<StatusNote step={step} />{notes}<Messages step={step} />{refusals}{changes}{activity}{viewer}
    </>
  ) : (
    <>
      <ProvisionalBox {...writes} />{decisionsPart}{integration}{chat}{retry}{switches}{summary}
      <ReviewNotes step={step} reviewing={reviewing} orchestratorAsks={orchestratorAsks} />
      {push}{rejected}<SentBack step={step} />{message}{questionsPart}<StatusNote step={step} /><GoalAcceptance step={step} />
      <Material project={id} step={step} pairs={pairs} />{viewer}
      <StepChecks step={step} /><StepMetrics step={step} />{notes}<Messages step={step} />{refusals}{changes}{activity}
      <StepCommits project={id} queue={queue.id} step={step.id} /><Timeline step={step} />
    </>
  );
  return (
    <>
      <PanelHeader
        wrap={!phone}
        where={/* The queue's line opens the queue's panel, from every step (docs/design/dashboard.md, "Merge back where it waits"). */
          <button onClick={() => nav.item(id, queue.id)} title={t("details.toQueue", { queue: queue.id })} className={`max-w-full text-left hover:text-accent ${phone ? "truncate" : ""}`}>
            {phone
              ? <>{project.project.name} · {queue.id} · <span className="text-fg">{step.id}</span> {step.title}</>
              : <><span className="font-mono">{queue.id}</span> · {queue.title} <span aria-hidden="true">›</span></>}
          </button>}
        of={of} bare={questionFirst}
        title={<><span className="mr-2 font-mono text-fg-3">{step.id}</span>{step.title}</>}
        status={<>
          {step.continued
            ? <StatusBadge status="continued" label={t("state.continuedIn", { refs: continuedShort(step.continued.in, queue.steps.map((s) => s.id)) })} />
            : <StatusBadge status={pendingProvisional(step) ? "review" : checkTone(step)} label={stepLabel(step) ?? provisionalWord(step)} />}
          {/* Until its review is over the user may change the step's level, also after approval (no new approval). */}
          {levelChangeable(step) && !readOnly
            ? <LevelPicker project={id} queue={queue.id} step={step} away={project.away} />
            : (
              <span title={levelTitle(step.level)} className="inline-flex items-center gap-1">
                <LevelMark step={step} always />
                <span>{levelShort(step.level)}{step.level_from === "user" ? ` · ${t("level.setByYou")}` : ""}{project.away.on && step.level === 2 ? ` · ${t("level.awayAs3")}` : ""}</span>
              </span>
            )}
          {accepted && <span className="inline-flex max-w-full flex-wrap rounded bg-surface-3 px-1.5 py-0.5 text-fg" title={accepted.title} data-accepted-by={step.accepted?.by ?? "helper-reviewing"}>
            {/* Each part whole (a model's name never breaks at its hyphens); the line wraps between them. */}
            {accepted.parts.map((x, i) => <span key={i} className="whitespace-pre">{i ? ` · ${x}` : x}</span>)}
          </span>}
          <StepTimes step={step} />
          {warned > 0 && <span className="font-medium text-warn">{t("details.metricsWarning", { count: warned })}</span>}
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
        ? <QuestionSheet key={`${id}/${asking!.qid}`} q={asking!} project={id} waiting={waiting}>{body}</QuestionSheet>
        : <PanelBody>
          <div ref={questionTop}>{waiting}</div>
          {qid && (selected
            ? <Question key={`${id}/${selected.qid}`} q={selected} project={id} readOnly={readOnly} />
            : <p role="status" className="text-sm text-fg-2">{t("details.question.unavailable")}</p>)}
          {body}
        </PanelBody>}
      {!questionFirst && reviewing && <ReviewBar key={`${id}/${queue.id}/${step.id}`} project={id} queue={queue} step={step} next={noteTargets(queue.steps, step.id).next} criteria={step.acceptance} />}
    </>
  );
}
