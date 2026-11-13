import { useState } from "react";
import type { Event, StatusChange } from "@nexus/protocol";
import { stopPlace } from "@nexus/protocol/attention";
import { stepValuesText } from "@nexus/protocol/steps";
import { act, actResult, enc, fileUrl, useFetch, type ProjectState, type QuestionView, type QueueView, type StepView } from "../api.ts";
import { noteTargets, pairPictures, showsReviewActions } from "../review.ts";
import { ActionBar, Button, Composer, Expandable, Markdown, PanelBody, PanelHeader, Section, StatusBadge, StepTimes, TEXTAREA, TimeAgo, reviewLabel, useDraftText, type MenuEntry } from "./ui.tsx";
import { Activity, RetryNote, RunControls } from "./Run.tsx";
import { StepRefusals } from "./Refusals.tsx";
import { draftKey, readDraft } from "../drafts.ts";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { ImageViewer, type ViewerImage } from "./Viewer.tsx";
import { StepChat } from "./Chat.tsx";

interface Props {
  project: ProjectState; queue: QueueView; onChanged: () => void; onClose: () => void;
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
  // Each picture with its before, if it has one (an explicit --before, else the same label in an earlier round).
  const pictures = pairPictures(step.review_items.filter(isImage));
  const images: ViewerImage[] = pictures.map(({ item: r, before, beforeLabel }) => ({
    src: fileUrl(id, r.path!), label: r.label ?? r.path!.split("/").at(-1)!, round: r.round,
    // An explicit before by its file name; one paired by label by its round.
    before: before ? { src: fileUrl(id, before), label: beforeLabel === "before" ? before.split(/[\\/]/).at(-1)! : beforeLabel ?? "before" } : undefined,
  }));
  const viewing = layerValue(useNav(), "viewer");
  const shown = viewing === undefined ? undefined : Math.min(Math.max(0, Number(viewing) || 0), images.length - 1);
  // The action bar: the user's review when the step waits for it; else the answer to the step's open question (the
  // first, if there are several; the others keep their answer box in their card).
  const reviewing = showsReviewActions(step);
  const asking = reviewing ? undefined : questions.find((q) => q.state === "open" || q.state === "escalated");
  return (
    <>
      <PanelHeader
        where={<><span className="font-mono">{queue.id}</span> · {queue.title}{of && <span className="ml-2 whitespace-nowrap text-fg-2">· {of}</span>}</>}
        title={<><span className="mr-2 font-mono text-fg-3">{step.id}</span>{step.title}</>}
        status={<>
          <StatusBadge status={step.status} label={reviewLabel(step)} />
          <StepTimes step={step} />
          {step.commit && <span className="font-mono">{step.commit}</span>}
          {session && <span>by {session.title ?? session.id.slice(-8)} ({session.runtime})</span>}
          {stepValuesText(step) && (
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-fg" title="This step's own runtime, model and effort; what it leaves out is the run's">
              runs on {stepValuesText(step)}
            </span>
          )}
        </>}
        onClose={onClose}
      />
      <PanelBody>
      <StepChat project={id} queue={queue.id} step={step.id} version={project.generated_at} />

      {queue.run?.state === "retry_wait" && queue.run.step === step.id && (
        <div className="mt-4 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm">
          <RetryNote run={queue.run} className="text-sm" />
          {queue.run.reason && <p className="mt-1 text-xs text-fg-2">{queue.run.reason}</p>}
        </div>
      )}

      {(step.summary || step.reason || step.progress) && (
        <div className="mt-4 rounded-lg bg-surface-2 p-3 text-sm">
          {step.summary && <p><span className="text-fg-3">Summary: </span>{step.summary}</p>}
          {step.reason && step.status !== "rejected" && <p className="text-stop"><span className="text-fg-3">Reason: </span>{step.reason}</p>}
          {step.progress && step.status === "running" && (
            <p><span className="text-fg-3">Now: </span>{step.progress.text} <span className="text-xs text-fg-3">(<TimeAgo at={step.progress.at} />)</span></p>
          )}
        </div>
      )}

      {step.status === "review" && step.review_with === "orchestrator" && (
        <Section title="Waiting for the orchestrator's review">
          <p className="text-sm text-fg-2">The queue holds here until the orchestrator accepts this step, sends it back, or hands it to you.</p>
        </Section>
      )}
      {reviewing && (
        <Section title="Waiting for your review">
          {step.asked_user?.text && <p className="mb-2 text-sm text-fg"><span className="text-fg-3">The orchestrator asks you: </span>{step.asked_user.text}</p>}
          <p className="text-sm text-fg-2">The queue holds here until you accept this step or send it back.</p>
        </Section>
      )}

      <PushLine project={id} queue={queue} step={step.id} onChanged={onChanged} />

      {step.status === "rejected" && <Rejected step={step} holding={queue.rejection?.step === step.id} />}

      {step.sent_back.length > 0 && (
        <Section title="Sent back">
          <ul className="space-y-2">
            {step.sent_back.map((b) => (
              <li key={b.id} className="text-sm">
                <div className="text-xs text-fg-3">
                  {b.by === "user" ? "You (Fix it)" : "Orchestrator"} · <TimeAgo at={b.at} /> · {b.to_user ? "beyond the limit: handed to you instead" : b.delivered ? `round ${b.round}` : "on its way to the worker"}
                </div>
                <p className="whitespace-pre-wrap text-fg">{b.text}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {live && session && (
        <Section title="Message the running agent" aside={<span className="text-xs text-fg-3">read at its next check-in</span>}>
          <Composer
            draft={draftKey(id, "message", queue.id, step.id)}
            placeholder="Delivered to the agent without stopping it…"
            button="Send"
            onSubmit={async (text) => { await act(id, "POST", `/sessions/${enc(session.id)}/messages`, { text, queue: queue.id, step: step.id }); onChanged(); }}
          />
        </Section>
      )}

      {questions.length > 0 && <Section title="Questions">{questions.map((q) => <Question key={q.qid} q={q} project={id} onChanged={onChanged} inBar={q.qid === asking?.qid} />)}</Section>}

      {step.status_note && (
        <Section title="Recorded state">
          <Expandable text={step.status_note} />
        </Section>
      )}

      {step.goal && <Section title="Goal"><Markdown>{step.goal}</Markdown></Section>}
      {step.acceptance.length > 0 && (
        <Section title="Acceptance">
          <ul className="space-y-1.5">
            {step.acceptance.map((a, i) => (
              <li key={i} className="flex gap-2 text-sm text-fg"><span className="text-fg-3">◇</span><Markdown className="[&_p]:m-0">{a}</Markdown></li>
            ))}
          </ul>
        </Section>
      )}
      {step.review?.prepare && <Section title="Review to prepare"><Markdown>{step.review.prepare}</Markdown></Section>}

      {step.review_items.length > 0 && (
        <Section title="Review material">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {step.review_items.map((r, i) => {
              const href = r.path ? fileUrl(id, r.path) : r.url!;
              const caption = <div className="truncate px-2 py-1 text-xs text-fg-2 group-hover:text-fg">{r.label ?? r.path ?? r.url}{r.round ? ` · round ${r.round}` : ""}</div>;
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

      {shown !== undefined && images.length > 0 && (
        <ImageViewer images={images} index={shown} onIndex={(i) => nav.open(`viewer:${i}`)} onClose={() => nav.close("viewer")}
          footer={(i) => <PictureActions key={pictures[i]!.item.path} project={id} queue={queue} step={step} path={pictures[i]!.item.path!} src={images[i]!.src} onChanged={onChanged} />} />
      )}

      {step.checks.length > 0 && (
        <Section title="Checks">
          <ul className="space-y-1 text-sm">
            {step.checks.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className={c.ok ? "text-ok" : "text-danger"}>{c.ok ? "✓" : "✗"}</span>
                <span className="text-fg">{c.name}</span>
                {c.summary && <span className="text-fg-3">{c.summary}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Notes" aside={<span className="text-xs text-fg-3">{forOrchestrator ? "go to the orchestrator, which weighs them in its review" : "delivered when the step starts"}</span>}>
        <div className="space-y-2">
          {step.notes.map((n) => (
            <div key={n.id} className="rounded-lg border border-line p-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-fg-3">
                <span>from {n.from}{n.to === "orchestrator" ? ", to the orchestrator" : ""}</span><TimeAgo at={n.at} />
                <span className={`ml-auto ${n.read_at ? "text-ok" : "text-info"}`}>{n.read_at ? (n.to === "orchestrator" ? "told the orchestrator" : "delivered") : n.to === "orchestrator" ? "on its way to the orchestrator" : "waiting for the step"}</span>
                {!n.read_at && <WithdrawNote project={id} queue={queue.id} step={step.id} note={n.id} onChanged={onChanged} />}
              </div>
              <Markdown>{n.body}</Markdown>
            </div>
          ))}
          {step.notes.length === 0 && !notesOpen && <p className="text-sm text-fg-3">None.</p>}
        </div>
        {notesOpen && (
          <div className="mt-3">
            <Composer
              draft={draftKey(id, "note", queue.id, step.id)}
              placeholder={forOrchestrator ? `A note for the orchestrator's review of ${step.id}: it weighs it, and sends the step back if you ask for a fix…` : `A note for ${step.id}: the agent reads it when it starts this step…`}
              button="Add note"
              onSubmit={async (text) => { await act(id, "POST", `/queues/${enc(queue.id)}/steps/${enc(step.id)}/notes`, { text }); onChanged(); }}
            />
          </div>
        )}
      </Section>

      {step.messages.length > 0 && (
        <Section title="Messages sent while it ran">
          <div className="space-y-2">
            {step.messages.map((m) => (
              <div key={m.id} className="rounded-lg border border-line p-3 text-sm">
                <div className="mb-1 flex gap-2 text-xs text-fg-3">
                  <span>from {m.from}</span><TimeAgo at={m.at} />
                  <span className={`ml-auto ${m.read_at ? "text-ok" : "text-info"}`}>{m.read_at ? "read" : "not read yet"}</span>
                </div>
                {m.type === "message" && <Markdown>{m.text}</Markdown>}
              </div>
            ))}
          </div>
        </Section>
      )}

      <StepRefusals project={project} queue={queue.id} step={step.id} />

      <Changes entries={queue.changes.filter((c) => c.step === step.id)} queue={queue} />

      {(step.session ?? (queue.run?.step === step.id ? queue.run.session : undefined)) && (
        <Activity project={id} session={(step.session ?? queue.run?.session)!} queue={queue.id} step={step.id} version={project.generated_at} />
      )}

      <StepCommits project={id} queue={queue.id} step={step.id} version={project.generated_at} />

      {step.timeline.length > 0 && (
        <Section title="Timeline">
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
      </PanelBody>
      {reviewing
        ? <ReviewBar key={step.id} project={id} queue={queue.id} step={step.id} next={noteTargets(queue.steps, step.id).next} criteria={step.acceptance} onChanged={onChanged} />
        : asking && <AnswerBar key={asking.qid} q={asking} project={id} onChanged={onChanged} />}
    </>
  );
}

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
      <p className="text-sm text-danger">Reject this step</p>
      <p className="mt-1 text-xs text-fg-2">The run pauses and nothing is reverted. The orchestrator is told and proposes what follows (a revert as a step, changed steps, or a new queue) for your approval; the run goes on only once you approve a new revision, and this step is not run again.</p>
      <textarea
        value={why} rows={2} placeholder="Why (optional)…" onChange={(e) => setWhy(e.target.value)}
        className="mt-2 w-full resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 focus:border-danger focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={reject} className="rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/25 disabled:opacity-40">{busy ? "Rejecting…" : "Reject the step"}</button>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
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
        <span className="text-fg-3">Rejected by you{step.reason ? ": " : ""}</span>
        {step.reason && <span className="text-danger">{step.reason}</span>}
        {at && <span className="text-xs text-fg-3"> · <TimeAgo at={at} /></span>}
      </p>
      <p className="mt-1 text-xs text-fg-2">
        {holding
          ? "Nothing was reverted. The run waits until you approve a new revision of the queue (the orchestrator proposes one); nothing of the queue is pushed until then."
          : "A newer revision was approved since; this step is not run again."}
      </p>
    </div>
  );
}

/** On a picture's tile: accepted, its comments, whether it has a before to compare with. */
function PictureBadges({ marks, paired }: { marks?: StepView["pictures"][string]; paired: boolean }) {
  if (!marks?.accepted && !marks?.comments.length && !paired) return null;
  const chip = "rounded bg-canvas/70 px-1.5 py-0.5 text-[11px]";
  return (
    <span className="absolute right-1.5 top-1.5 flex gap-1">
      {paired && <span className={`${chip} text-fg`} title="Has a before to compare with">⇄</span>}
      {marks?.accepted && <span className={`${chip} text-ok`} title="You marked it accepted">✓</span>}
      {!!marks?.comments.length && <span className={`${chip} text-info`} title="Your comments">💬 {marks.comments.length}</span>}
    </span>
  );
}

/**
 * The viewer's action bar: mark the picture accepted (a mark only; the step is not accepted), comment on it, and the
 * original file under ⋯. A comment goes back to the worker as a Fix it while the step waits for the user's review;
 * otherwise it is a note on the next pending step. The comment box opens by itself when there are comments or a draft.
 */
function PictureActions({ project, queue, step, path, src, onChanged }: { project: string; queue: QueueView; step: StepView; path: string; src: string; onChanged: () => void }) {
  const marks = step.pictures[path];
  const [error, setError] = useState<string>();
  const [commentOpen, setCommentOpen] = useState(() => !!marks?.comments.length || !!readDraft(draftKey(project, "picture", queue.id, step.id, path)));
  const next = noteTargets(queue.steps, step.id).next;
  const where = showsReviewActions(step) ? "goes back to the worker with the step (a Fix it: your words win over its criteria)"
    : step.status === "review" && step.review_with === "orchestrator" ? "goes to the orchestrator, which weighs it in its review of the step and sends the step back if you ask for a fix"
    : next ? `becomes a note on step ${next}, delivered when it starts` : undefined;
  const base = `/queues/${enc(queue.id)}/steps/${enc(step.id)}/pictures`;
  return (
    <ActionBar
      hint={error ? <span className="text-danger">{error}</span> : "A mark for this picture; the step is not accepted by it."}
      menu={[{ label: "Open the original ↗", onSelect: () => window.open(src, "_blank", "noreferrer") }]}
      secondary={where ? <Button variant="quiet" pressed={commentOpen} onClick={() => setCommentOpen(!commentOpen)}>Comment…</Button> : undefined}
      primary={
        <button
          onClick={() => act(project, "POST", `${base}/mark`, { path, accepted: !marks?.accepted }).then(onChanged, (e: Error) => setError(e.message))}
          aria-pressed={!!marks?.accepted}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${marks?.accepted ? "bg-ok/20 text-ok ring-1 ring-ok/50" : "bg-accent-strong text-on-accent hover:bg-accent"}`}
        >{marks?.accepted ? "✓ Accepted" : "Mark accepted"}</button>
      }
    >
      {(commentOpen || !where) && <div className="space-y-2 text-sm">
      {marks?.comments.map((c, i) => (
        <div key={i} className="rounded-md bg-surface-3 px-2 py-1.5">
          <p className="whitespace-pre-wrap text-fg">{c.text}</p>
          <p className="text-[11px] text-fg-3">{c.to === "send_back" ? "sent back to the worker" : c.to === "orchestrator" ? "to the orchestrator's review" : `a note on step ${c.note_step}`} · <TimeAgo at={c.at} /></p>
        </div>
      ))}
      {where ? (
        <div>
          <Composer
            draft={draftKey(project, "picture", queue.id, step.id, path)}
            placeholder="A comment on this picture…"
            button="Comment"
            rows={2}
            onSubmit={async (text) => { await act(project, "POST", `${base}/comment`, { path, text }); onChanged(); }}
          />
          <p className="mt-1 text-[11px] text-fg-3">The comment {where}.</p>
        </div>
      ) : <p className="text-xs text-fg-3">No step to take a comment: this step is not waiting for your review and nothing after it is pending.</p>}
      </div>}
    </ActionBar>
  );
}

interface CommitView { sha: string; subject: string; author: string; at: string; files: number; insertions: number; deletions: number; foreign: boolean }
interface RoundView { session: string; start: string | null; end: string | null; open: boolean; commits: CommitView[] }

/** The commits of each round of the step (server: src/gitinfo.ts); nothing outside a git repository. */
function StepCommits({ project, queue, step, version }: { project: string; queue: string; step: string; version: unknown }) {
  const data = useFetch<{ rounds: RoundView[] } | null>(`/api/projects/${enc(project)}/queues/${enc(queue)}/steps/${enc(step)}/commits`, version);
  if (!data) return null;
  const several = data.rounds.length > 1;
  const foreign = data.rounds.some((r) => r.commits.some((c) => c.foreign));
  return (
    <Section title="Commits" aside={foreign ? <span className="text-xs text-warn/80">◆ not by this step's worker</span> : undefined}>
      <div className="space-y-3">
        {data.rounds.map((r, i) => (
          <div key={i}>
            {several && <div className="mb-1 text-xs text-fg-3">Round {i + 1}{r.open ? " (at work)" : ""}</div>}
            {r.commits.length === 0
              ? <p className="text-sm text-fg-3">{r.open ? "No commit yet." : "No commit."}</p>
              : (
                <ul className="space-y-1.5">
                  {r.commits.map((c) => (
                    <li key={c.sha} className="text-sm">
                      <div className="flex gap-2">
                        <span className="shrink-0 font-mono text-xs leading-5 text-fg-3">{c.sha.slice(0, 7)}</span>
                        <span className={`min-w-0 ${c.foreign ? "text-warn" : "text-fg"}`}>{c.foreign && <span className="text-warn" title="Not made in a turn of this step's worker">◆ </span>}{c.subject}</span>
                      </div>
                      <div className="pl-[3.75rem] text-xs text-fg-3">
                        {c.files} file{c.files === 1 ? "" : "s"} · <span className="text-ok/80">+{c.insertions}</span> <span className="text-danger/80">−{c.deletions}</span> · {c.author} · <TimeAgo at={c.at} />
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
  const branch = queue.branch ?? "its branch";
  const base = g?.base?.branch !== false ? g?.base?.ref : undefined;
  const go = (what: "merge" | "cleanup") => {
    setBusy(true); setResult(undefined);
    fetch(`/api/projects/${enc(project)}/queues/${enc(queue.id)}/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then(async (r) => { const b = await r.json().catch(() => ({})) as { result?: { message?: string }; error?: string }; setResult(r.ok ? { ok: true, text: b.result?.message ?? "done" } : { ok: false, text: b.error ?? r.statusText }); if (r.ok) setAsk(undefined); onChanged(); })
      .catch((e: Error) => setResult({ ok: false, text: e.message }))
      .finally(() => setBusy(false));
  };
  return (
    <Section title="Worktree">
      <p className="break-all text-xs text-fg-3"><span className="font-mono">{queue.worktree}</span> on <span className="font-mono">{branch}</span>{g?.base ? <> from <span className="font-mono">{g.base.ref}</span></> : null}</p>
      {g?.merged && <p className="mt-1.5 text-sm text-ok">Merged into <span className="font-mono">{g.merged.into}</span> ({g.merged.fast_forward ? "fast-forward" : `merge commit ${g.merged.sha.slice(0, 7)}`}) <span className="text-xs text-fg-3">· <TimeAgo at={g.merged.at} /></span></p>}
      {g?.cleaned
        ? <p className="mt-1.5 text-sm text-fg">Cleaned up: the worktree removed, branch <span className="font-mono">{g.cleaned.branch}</span> deleted <span className="text-xs text-fg-3">· <TimeAgo at={g.cleaned.at} /></span></p>
        : (
          <div className="mt-2 flex flex-wrap gap-2">
            {base && !g?.merged && <Button variant="quiet" onClick={() => { setAsk("merge"); setResult(undefined); }}>Merge into {base}…</Button>}
            <Button variant="quiet" onClick={() => { setAsk("cleanup"); setResult(undefined); }}>Clean up…</Button>
          </div>
        )}
      {ask && !g?.cleaned && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3">
          {ask === "merge" ? (
            <>
              <p className="text-sm text-warn">Merge <span className="font-mono">{branch}</span> into <span className="font-mono">{base}</span>?</p>
              <p className="mt-1 text-xs text-fg-2">In the worktree where {base} is checked out: a fast-forward when possible, else a merge commit. Refused if that worktree has uncommitted changes or a run is going there; on a conflict the merge is aborted and nothing changes. Nothing is pushed.</p>
            </>
          ) : (
            <>
              <p className="text-sm text-warn">Clean up this queue's worktree?</p>
              <p className="mt-1 text-xs text-fg-2">Removes the worktree (git worktree remove) and deletes branch <span className="font-mono">{branch}</span> (git branch -d). Refused, with nothing removed, if the worktree has uncommitted changes or the branch is not merged.</p>
            </>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => go(ask)}>{busy ? "Working…" : ask === "merge" ? "Merge" : "Clean up"}</Button>
            <Button variant="quiet" onClick={() => setAsk(undefined)}>Cancel</Button>
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
    <span><span className="text-ok">{x.ahead} ahead</span>, <span className={x.behind ? "text-warn" : "text-fg-2"}>{x.behind} behind</span></span>
  );
  return (
    <div className="mt-3 space-y-0.5 rounded-lg bg-surface-2 p-3 text-sm text-fg">
      <p><span className="text-fg-3">Branch </span><span className="font-mono">{b.branch}</span></p>
      {b.base && <p className="text-xs">{counts(b.base)} <span className="text-fg-3">of its base</span> <span className="font-mono">{b.base.ref}</span></p>}
      {b.upstream
        ? <p className="text-xs">{counts(b.upstream)} <span className="text-fg-3">of</span> <span className="font-mono">{b.upstream.ref}</span> <span className="text-fg-3">as fetched {b.upstream.at ? <TimeAgo at={b.upstream.at} /> : "at an unknown time"}</span></p>
        : <p className="text-xs text-fg-3">No remote-tracking branch.</p>}
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
        <span className="text-fg-3">{failed ? "Push failed: " : p.result === "pushed" ? "Pushed: " : "Push: "}</span>
        <span className={failed ? "text-danger" : "text-fg"}>{p.text}</span>
        <span className="text-xs text-fg-3"> · <TimeAgo at={p.at} /></span>
      </p>
      {failed && <p className="mt-1 text-xs text-fg-2">The step stays accepted. The next accepted step pushes again, or push again now.</p>}
      {latest && (
        <div className="mt-2 flex items-center gap-3">
          <Button variant="quiet" disabled={busy} onClick={() => { setBusy(true); setError(undefined); act(project, "POST", `/queues/${enc(queue.id)}/push`).then(onChanged, (e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>{busy ? "Pushing…" : "Push again"}</Button>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      )}
    </div>
  );
}

const POLICY_LABEL: Record<string, string> = { continue: "go on", wait: "wait for my review", orchestrator: "the orchestrator reviews" };

/**
 * The bar of a step in the user's review: Accept and go on, Fix it… beside it, Reject and a note with the acceptance
 * under ⋯. Fix it opens with the text kept from before, if there is one.
 */
function ReviewBar({ project, queue, step, next, criteria, onChanged }: { project: string; queue: string; step: string; next?: string; criteria: string[]; onChanged: () => void }) {
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
    ...(noteOpen ? [] : [{ label: "Add a note to the acceptance…", onSelect: () => setNoteOpen(true) }]),
    ...(rejectOpen ? [] : [{ label: "Reject…", danger: true, onSelect: () => setRejectOpen(true) }]),
  ];
  const opened = noteOpen || fixOpen || rejectOpen;
  return (
    <ActionBar
      hint={error ? <span className="text-danger">{error}</span> : undefined}
      menu={menu}
      secondary={<Button variant="quiet" pressed={fixOpen} onClick={() => setFixOpen(!fixOpen)}>Fix it…</Button>}
      primary={<Button onClick={() => void accept()}>{note.trim() ? "Accept with the note" : "Accept and go on"}</Button>}
    >
      {opened && <div className="space-y-4">
      {rejectOpen && <RejectStep project={project} queue={queue} step={step} onChanged={onChanged} onCancel={() => setRejectOpen(false)} />}
      {noteOpen && (
        <div>
          <textarea
            value={note} rows={2} placeholder="A note with your acceptance (optional)…" onChange={(e) => setNote(e.target.value)}
            className={TEXTAREA}
          />
          {next ? (
            <label className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-fg-2">
              The note goes to
              <select value={noteTo} onChange={(e) => setNoteTo(e.target.value as "next" | "orchestrator")} className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-fg">
                <option value="next">the next step ({next}), when it starts</option>
                <option value="orchestrator">the orchestrator (the plan, later queues, the rules)</option>
              </select>
            </label>
          ) : (
            <p className="mt-1.5 text-xs text-fg-2">The note goes to the orchestrator: this is the queue's last step.</p>
          )}
        </div>
      )}
      {fixOpen && <div>
        <p className="mb-1.5 text-sm text-fg">Fix it</p>
        <p className="mb-2 text-xs text-fg-3">Sends the step back to its worker with your words. Where they conflict with the step's acceptance criteria, your words win.</p>
        <Composer
          draft={draftKey(project, "fix", queue, step)}
          placeholder="What you want instead…"
          button="Fix it"
          verbatim
          onSubmit={(text) => criteria.length
            ? new Promise<void>((resolve, reject) => setConfirm({ resolve, reject, send: () => send(text) }))
            : send(text)}
        />
        {confirm && (
          <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3">
            <p className="text-sm text-warn">Your words override these acceptance criteria where they conflict:</p>
            <ul className="mt-1.5 space-y-1">
              {criteria.map((c, i) => <li key={i} className="flex gap-2 text-sm text-fg"><span className="text-fg-3">◇</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => { const c = confirm; setConfirm(undefined); c.send().then(c.resolve, c.reject); }}>Send it back</Button>
              <Button variant="quiet" onClick={() => { const c = confirm; setConfirm(undefined); c.reject(new Error("Not sent; your text is kept.")); }}>Cancel</Button>
            </div>
          </div>
        )}
      </div>}
      </div>}
    </ActionBar>
  );
}

/** The bar of a step with an open question: the answer box, whether the worker may go on, and Answer. */
function AnswerBar({ q, project, onChanged }: { q: QuestionView; project: string; onChanged: () => void }) {
  const [goOn, setGoOn] = useState(true);
  const t = useDraftText({
    draft: draftKey(project, "answer", q.qid),
    onSubmit: async (text) => { await act(project, "POST", `/questions/${enc(q.qid)}/answer`, { text, continue: goOn }); onChanged(); },
  });
  return (
    <ActionBar
      hint={t.error ? <span className="text-danger">{t.error}</span> : "Ctrl+Enter answers"}
      primary={<Button onClick={t.submit} disabled={!t.ready}>{t.busy ? "Sending…" : "Answer"}</Button>}
    >
      <textarea value={t.text} rows={2} placeholder="Your answer…" onChange={(e) => t.change(e.target.value)} onKeyDown={t.onKeyDown} className={TEXTAREA} />
      <label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-2">
        <input type="checkbox" checked={goOn} onChange={(e) => setGoOn(e.target.checked)} className="accent-accent" />
        the worker may go on
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
      >withdraw</button>
    </>
  );
}

function describe(e: Event): string {
  switch (e.type) {
    case "step.progress": return e.text + (e.pct !== undefined ? ` (${e.pct}%)` : "");
    case "step.done": return e.summary;
    case "step.failed": return e.reason;
    case "queue.stop": return `${e.condition}: ${e.reason}`;
    case "check.result": return `${e.ok ? "✓" : "✗"} ${e.name}${e.summary ? ` — ${e.summary}` : ""}`;
    case "review.added": return e.items.map((i) => i.label ?? i.path ?? i.url).join(", ");
    case "question.asked": return e.text;
    case "answer.given": return e.text;
    case "context.summary": return e.text.slice(0, 200);
    case "review.accepted": return e.text ?? "";
    case "review.sent_back": return e.text;
    case "review.asked_user": return e.text;
    case "review.rejected": return e.text ?? "";
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
        <StatusBadge status={q.state === "open" ? "waiting" : q.state === "escalated" ? "review" : "done"} label={q.state === "escalated" ? "for you" : q.state} />
        {q.queue && <span className="font-mono">{q.queue}{q.step ? `/${q.step}` : ""}</span>}
        <span>{q.can_continue ? "the worker goes on meanwhile" : "the worker waits"}</span>
        <span className="ml-auto"><TimeAgo at={q.asked_at} /></span>
      </div>
      <p className="text-fg">{q.text}</p>
      {q.options && <ul className="mt-1 list-disc pl-5 text-fg-2">{q.options.map((o) => <li key={o}>{o}</li>)}</ul>}
      {q.answers.map((a) => (
        <div key={a.id} className="mt-2 border-t border-line pt-2 text-fg">
          <span className="text-fg-3">{a.escalate ? "Passed to you by the orchestrator: " : `Answer (${a.by}): `}</span>
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
      placeholder="Your answer…"
      button="Answer"
      extra={
        <label className="flex items-center gap-1.5 text-xs text-fg-2">
          <input type="checkbox" checked={goOn} onChange={(e) => setGoOn(e.target.checked)} className="accent-accent" />
          the worker may go on
        </label>
      }
      onSubmit={async (text) => { await act(project, "POST", `/questions/${enc(q.qid)}/answer`, { text, continue: goOn }); onChanged(); }}
    />
  );
}

// ---------------------------------------------------------------- queue

/**
 * Takes the approval back from a queue that has never run (it is proposed again). A started queue is paused or
 * stopped instead, so this is not offered there.
 */
/**
 * A stopped queue: why, where, and the way on. Continue (the user's lift) only when the current revision is approved;
 * otherwise approving the revision lifts the stop. The orchestrator's proposal, when there is one, is shown with it.
 */
interface LeftView {
  step: string;
  commits: { sha: string; subject: string; author: string; at: string; files: number; insertions: number; deletions: number }[];
  uncommitted: { status: string; path: string }[];
  uncommitted_note: string;
  discarded: { at: string } | null;
}

/**
 * What the stopped step left: its own commits, with Keep or Discard when there are any, and the checkout's uncommitted
 * changes, which are not necessarily the step's and are never cleaned.
 */
function StoppedWork({ left, work, setWork, needsChoice, pushAccepted, branch }: {
  left: LeftView; work?: "keep" | "discard"; setWork: (w: "keep" | "discard") => void; needsChoice: boolean; pushAccepted: boolean; branch?: string;
}) {
  if (!left.commits.length && !left.uncommitted.length) return <p className="mt-3 text-xs text-fg-2">Step {left.step} left no commits and no uncommitted changes.</p>;
  const n = left.commits.length;
  const option = (value: "keep" | "discard", title: string, text: string) => (
    <label className={`flex cursor-pointer gap-2 rounded-md p-2 ring-1 ${work === value ? "bg-surface ring-accent/60" : "ring-line-strong hover:bg-surface/60"}`}>
      <input type="radio" name="stopped-work" checked={work === value} onChange={() => setWork(value)} className="mt-1 accent-accent" />
      <span><span className="font-medium text-fg">{title}</span><span className="block text-xs text-fg-2">{text}</span></span>
    </label>
  );
  return (
    <div className="mt-3 space-y-3 rounded-md bg-surface/70 p-2.5">
      {n > 0 && (
        <div>
          <p className="text-xs text-fg-2">Step {left.step} left {n} commit{n === 1 ? "" : "s"} of its own:</p>
          <ul className="mt-1 space-y-1">
            {left.commits.map((c) => (
              <li key={c.sha} className="text-sm">
                <span className="font-mono text-xs text-fg-3">{c.sha.slice(0, 7)}</span> <span className="text-fg">{c.subject}</span>
                <span className="block pl-[3.6rem] text-[11px] text-fg-3">{c.files} file{c.files === 1 ? "" : "s"} · <span className="text-ok/80">+{c.insertions}</span> <span className="text-danger/80">−{c.deletions}</span> · <TimeAgo at={c.at} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {left.uncommitted.length > 0 && (
        <div>
          <p className="text-xs text-fg-2">Uncommitted changes {left.uncommitted_note}; Nexus never cleans them:</p>
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-fg">
            {left.uncommitted.map((u) => <li key={u.path} className="break-all"><span className="inline-block w-6 text-warn/90">{u.status}</span>{u.path}</li>)}
          </ul>
        </div>
      )}
      {left.discarded && <p className="text-sm text-fg">You chose to discard these commits <TimeAgo at={left.discarded.at} />: the orchestrator proposes a revision that reverts them, and approving it lifts the stop.</p>}
      {needsChoice && (
        <div className="space-y-1.5" role="radiogroup" aria-label="The stopped step's commits">
          {option("keep", "Keep", pushAccepted
            ? `The commits stay, and go out with the next accepted step's push${branch ? ` to ${branch}` : ""}.`
            : `The commits stay, local in the branch${branch ? ` ${branch}` : ""}; nothing is pushed.`)}
          {option("discard", "Discard", "The stop stays. The orchestrator proposes a revision whose first step reverts these commits (and only these); approving it lifts the stop.")}
        </div>
      )}
    </div>
  );
}

/** A stopped queue's stop: why and where, the orchestrator's proposal, what the step left; Continue is in the bar. */
function StopBox({ queue, left, work, setWork, needsChoice, pushAccepted }: {
  queue: QueueView; left?: LeftView; work?: "keep" | "discard"; setWork: (w: "keep" | "discard") => void; needsChoice: boolean; pushAccepted: boolean;
}) {
  const p = queue.lift_proposal;
  return (
    <div className="mt-4 rounded-lg border border-stop/30 bg-stop/10 p-3 text-sm">
      <p className="font-medium text-stop">Stopped{stopPlace(queue)}</p>
      {queue.status_reason && <div className="mt-1 text-fg"><Expandable text={queue.status_reason} /></div>}
      {p && (
        <div className="mt-3 rounded-md bg-surface/70 p-2.5">
          <p className="text-xs text-fg-3">The orchestrator proposes to continue · <TimeAgo at={p.at} /></p>
          <p className="mt-0.5 text-fg">{p.reason}</p>
        </div>
      )}
      {left && <StoppedWork left={left} work={work} setWork={setWork} needsChoice={needsChoice} pushAccepted={pushAccepted} branch={queue.branch} />}
      {!queue.approved && (
        <p className="mt-3 text-xs text-fg-2">Revision {queue.revision} is not approved yet: approving it lifts the stop{needsChoice ? " (with your choice above)" : ""}.</p>
      )}
    </div>
  );
}

const WHO: Record<StatusChange["by"], string> = { user_approval: "You, approving", user_continue: "You, with Continue", orchestrator: "Orchestrator" };

/** Status changes made through Nexus (queue.yaml's changes): who, when, what and why; newest first. */
function Changes({ entries, queue }: { entries: StatusChange[]; queue: QueueView }) {
  if (!entries.length) return null;
  const what = (c: StatusChange) => {
    switch (c.kind) {
      case "lift": return `lifted the stop${c.revision ? ` (revision ${c.revision})` : ""}`;
      case "proposal": return "proposed to lift the stop";
      case "run": return "closed the halted run as finished";
      case "work": return c.to === "kept"
        ? `kept the work of stopped step ${c.step} (${c.commits?.length ?? 0} commit${c.commits?.length === 1 ? "" : "s"})`
        : `chose to discard the work of stopped step ${c.step} (${c.commits?.length ?? 0} commit${c.commits?.length === 1 ? "" : "s"}): the orchestrator drafts a revision that reverts it`;
      default: return c.step ? `${c.step}: ${c.from} → ${c.to}` : `queue ${queue.id}: ${c.from} → ${c.to}`;
    }
  };
  return (
    <Section title="Changes">
      <ul className="space-y-2">
        {[...entries].reverse().map((c, i) => (
          <li key={i} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-3">
              <span className={c.by === "orchestrator" ? "text-review" : "text-info"}>{WHO[c.by]}</span>
              <TimeAgo at={c.at} />
            </div>
            <div className="text-fg">{what(c)}</div>
            {c.reason && <div className="text-xs text-fg-2">{c.kind === "lift" ? "The stop was: " : "Why: "}{c.reason}</div>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function WithdrawApproval({ project, queue, onChanged, onCancel }: { project: string; queue: string; onChanged: () => void; onCancel: () => void }) {
  return (
    <div className="rounded-lg border border-stop/30 bg-stop/5 p-3">
      <p className="mb-2 text-sm text-fg">
        The queue has not started. Withdrawing puts it back to proposed: it waits for your approval again and cannot be started until then. The earlier approval stays on record.
      </p>
      <Composer
        rows={2}
        allowEmpty
        draft={draftKey(project, "withdraw", queue)}
        placeholder="Why (optional)…"
        button="Withdraw approval"
        extra={<Button variant="quiet" onClick={onCancel}>Cancel</Button>}
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
    <Section title="Steps on their own runtime or model">
      <ul className="space-y-1 text-sm">
        {own.map((s) => (
          <li key={s.id} className="flex flex-wrap gap-x-2">
            <span className="font-mono text-fg-3">{s.id}</span>
            <span className="text-fg">{s.title}</span>
            <span className="text-review">⚙ {stepValuesText(s)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-fg-3">The other steps, and what a step leaves out, run on the run's runtime, model and effort.</p>
    </Section>
  );
}

export function QueueDetail({ project, queue, onChanged, onClose, of }: Props) {
  const id = project.project.id;
  const latest = queue.approvals.at(-1);
  const inherited = project.project.defaults.stop_conditions;
  // A stopped queue: what its stopped step left, and the user's Keep or Discard, shared by Continue and the approval.
  const left = useFetch<LeftView | null>(queue.status === "stopped" ? `/api/projects/${enc(id)}/queues/${enc(queue.id)}/left` : undefined, project.generated_at);
  const [work, setWork] = useState<"keep" | "discard">();
  const needsChoice = !!left && left.commits.length > 0 && !left.discarded;

  return (
    <>
      <PanelHeader
        where={<>{project.project.name} · queue{of && <span className="ml-2 whitespace-nowrap text-fg-2">· {of}</span>}</>}
        title={<><span className="mr-2 font-mono text-fg-3">{queue.id}</span>{queue.title}</>}
        status={<>
          <StatusBadge status={queue.status} />
          <span>revision {queue.revision}</span>
          {queue.branch && <span className="font-mono">{queue.branch}</span>}
          {queue.worktree && <span className="font-mono">{queue.worktree}</span>}
          <span className={queue.approved ? "text-ok" : "text-fg-3"}>
            {queue.approved ? "approved" : queue.withdrawals.length && queue.withdrawals.at(-1)!.approvals >= queue.approvals.length ? "approval withdrawn" : latest ? "approval is for an older revision" : "no approval recorded in Nexus"}
          </span>
        </>}
        onClose={onClose}
      />
      <PanelBody>
      <BranchLine project={id} queue={queue.id} version={project.generated_at} />
      <WorktreeActions project={id} root={project.project.root} queue={queue} onChanged={onChanged} />

      {queue.status === "stopped"
        ? <StopBox queue={queue} left={left ?? undefined} work={work} setWork={setWork} needsChoice={needsChoice} pushAccepted={project.project.defaults.push_accepted} />
        : queue.status_reason && <Section title="State"><Expandable text={queue.status_reason} /></Section>}
      {queue.report && (
        <Section title="Queue report">
          <p className="text-sm text-fg">{queue.report.summary}</p>
          <a className="text-sm text-accent underline" href={fileUrl(id, queue.report.path)} target="_blank" rel="noreferrer">Open the report</a>
        </Section>
      )}
      {queue.questions.length > 0 && <Section title="Questions">{queue.questions.map((q) => <Question key={q.qid} q={q} project={id} onChanged={onChanged} />)}</Section>}

      <OwnValues queue={queue} />

      <Section title="Approval">
        {[...queue.approvals.map((a) => ({ ...a, withdrawn: false as const })), ...queue.withdrawals.map((w) => ({ ...w, withdrawn: true as const }))]
          .sort((x, y) => x.at.localeCompare(y.at))
          .map((a, i) => (
            <p key={i} className={`mb-1 text-sm ${a.withdrawn ? "text-stop/90" : "text-fg"}`}>
              r{a.revision} · {a.withdrawn ? "withdrawn " : ""}<TimeAgo at={a.at} />
              {!a.withdrawn && a.words && <> · <q className="italic">{a.words}</q></>}
              {a.withdrawn && a.reason && <> · <q className="italic">{a.reason}</q></>}
            </p>
          ))}
        {!queue.approved && (
          <div className="mt-2">
            <p className="mb-2 text-sm text-fg-2">
              Approving pins revision {queue.revision}: its steps, acceptance criteria, checks and stop conditions. A later change needs a new approval.
              {queue.status === "stopped" && " It also lifts the stop."}
            </p>
            {queue.status === "stopped" && needsChoice && (
              <p className={`mb-2 text-sm ${work ? "text-fg" : "text-warn"}`}>
                {work === "keep" ? `With Keep: step ${left!.step}'s commits stay.` : work === "discard" ? `With Discard nothing is approved now: the orchestrator proposes a revision that reverts step ${left!.step}'s commits.` : `First choose Keep or Discard for step ${left!.step}'s commits, in the stop box above.`}
              </p>
            )}
            {queue.status === "stopped" && left?.discarded && (
              <p className="mb-2 text-sm text-fg">You chose to discard step {left.step}'s work: approving this revision lifts the stop.</p>
            )}
          </div>
        )}
      </Section>

      <RunControls project={project} queue={queue} onChanged={onChanged} />

      <Changes entries={queue.changes} queue={queue} />

      {queue.description && <Section title="Description"><Expandable text={queue.description} lines={6} /></Section>}

      <Section title="Stop conditions">
        <ul className="space-y-1.5 text-sm text-fg">
          {queue.stop_conditions.map((c, i) => <li key={i} className="flex gap-2"><span className="text-stop/70">■</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
          {inherited.map((c, i) => <li key={`p${i}`} className="flex gap-2 text-fg-3"><span>□</span><span>{c} <span className="text-xs">(project)</span></span></li>)}
          {queue.stop_conditions.length + inherited.length === 0 && <li className="text-fg-3">None.</li>}
        </ul>
      </Section>
      {queue.checks.length > 0 && (
        <Section title="Checks for every step">
          {queue.checks.map((c, i) => <Markdown key={i}>{c}</Markdown>)}
        </Section>
      )}
      {queue.source && (
        <p className="mt-6 text-xs text-fg-3">Imported from <span className="font-mono">{queue.source.path}</span> <TimeAgo at={queue.source.imported_at} /></p>
      )}
      </PanelBody>
      <QueueBar key={queue.id} project={project} queue={queue} onChanged={onChanged} left={left ?? undefined} work={work} needsChoice={needsChoice} />
    </>
  );
}

/**
 * The bar of a queue: Continue on a stopped queue whose revision is approved; Approve revision N (words with it under
 * ⋯) on one that is not; Withdraw approval (a queue approved but never started) and the review policy under ⋯.
 */
function QueueBar({ project, queue, onChanged, left, work, needsChoice }: {
  project: ProjectState; queue: QueueView; onChanged: () => void; left?: LeftView; work?: "keep" | "discard"; needsChoice: boolean;
}) {
  const id = project.project.id;
  const stopped = queue.status === "stopped";
  // What the server said back after Continue or an approval with Keep or Discard (the orchestrator drafts a revert…).
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setError(undefined); setNote(undefined);
    try {
      const r = await actResult<{ message?: string } | string>(id, "POST", `/queues/${enc(queue.id)}/continue`, needsChoice ? { work } : {});
      if (r && typeof r === "object" && r.message) setNote(r.message);
      onChanged();
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const wordsKey = draftKey(id, "approval", queue.id);
  const [wordsOpen, setWordsOpen] = useState(() => !!readDraft(wordsKey));
  const words = useDraftText({
    draft: wordsKey, allowEmpty: true,
    onSubmit: async (text) => {
      if (stopped && needsChoice && !work) throw new Error("choose Keep or Discard first, in the stop box above");
      const r = await actResult<{ message?: string }>(id, "POST", `/queues/${enc(queue.id)}/approve`, { words: text, work: needsChoice ? work : undefined });
      if (r?.message) setNote(r.message);
      onChanged();
    },
  });
  const canWithdraw = queue.approved && !queue.run && queue.steps.every((s) => s.status === "pending" && s.segments.length === 0);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const setPolicy = (review_policy: string | null) =>
    act(id, "PATCH", `/queues/${enc(queue.id)}`, { review_policy }).then(onChanged, (e: Error) => setError(e.message));
  const policy = queue.review_policy ? POLICY_LABEL[queue.review_policy] : `project default (${POLICY_LABEL[project.project.defaults.review_policy]})`;

  const menu: MenuEntry[] = [
    ...(!queue.approved && !wordsOpen ? [{ label: "Your words with the approval…", onSelect: () => setWordsOpen(true) }] : []),
    ...(canWithdraw && !withdrawOpen ? [{ label: "Withdraw approval…", danger: true, onSelect: () => setWithdrawOpen(true) }] : []),
    ...(!policyOpen ? [{ label: `After each step: ${policy}…`, onSelect: () => setPolicyOpen(true) }] : []),
  ];
  const fail = error ?? words.error;
  const hint = fail ? <span className="text-danger">{fail}</span>
    : note ? <span className="text-info">{note}</span>
    : stopped && queue.approved
      ? (needsChoice && !work ? "Choose Keep or Discard first." : needsChoice && work === "discard" ? "The stop stays until you approve the orchestrator's revert." : "Lifts the stop; the stopped step runs again in its session, unless it was skipped.")
      : undefined;
  const primary = stopped && queue.approved
    ? <Button disabled={busy || (needsChoice && !work)} onClick={() => void go()}>{needsChoice && work === "discard" ? "Discard and ask for a revert" : "Continue"}</Button>
    : !queue.approved
      ? <Button disabled={!words.ready} onClick={words.submit}>{words.busy ? "Sending…" : stopped && needsChoice && work === "discard" ? "Discard the step's work" : `Approve revision ${queue.revision}`}</Button>
      : undefined;
  const opened = (!queue.approved && wordsOpen) || (canWithdraw && withdrawOpen) || policyOpen;
  return (
    <ActionBar hint={hint} menu={menu} primary={primary}>
      {opened && (
        <div className="space-y-4">
          {!queue.approved && wordsOpen && (
            <textarea value={words.text} rows={2} placeholder="Your words with the approval (optional)…"
              onChange={(e) => words.change(e.target.value)} onKeyDown={words.onKeyDown} className={TEXTAREA} />
          )}
          {canWithdraw && withdrawOpen && <WithdrawApproval project={id} queue={queue.id} onChanged={onChanged} onCancel={() => setWithdrawOpen(false)} />}
          {policyOpen && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
              <label className="flex flex-wrap items-center gap-2">
                After each step
                <select
                  value={queue.review_policy ?? ""}
                  onChange={(e) => void setPolicy(e.target.value || null)}
                  className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-sm"
                >
                  <option value="">project default ({POLICY_LABEL[project.project.defaults.review_policy]})</option>
                  <option value="continue">go on to the next step</option>
                  <option value="wait">wait for my review</option>
                  <option value="orchestrator">wait for the orchestrator's review</option>
                </select>
              </label>
              <Button variant="quiet" onClick={() => setPolicyOpen(false)}>Done</Button>
            </div>
          )}
        </div>
      )}
    </ActionBar>
  );
}
