import { useState } from "react";
import type { Event, StatusChange } from "@nexus/protocol";
import { stopPlace } from "@nexus/protocol/attention";
import { stepValuesText } from "@nexus/protocol/steps";
import { act, enc, fileUrl, useFetch, type ProjectState, type QuestionView, type QueueView, type StepView } from "../api.ts";
import { noteTargets, pairPictures, showsReviewActions } from "../review.ts";
import { Button, Composer, Expandable, Markdown, Section, StatusBadge, StepTimes, TimeAgo, reviewLabel } from "./ui.tsx";
import { Activity, RetryNote, RunControls } from "./Run.tsx";
import { StepRefusals } from "./Refusals.tsx";
import { draftKey } from "../drafts.ts";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { ImageViewer, type ViewerImage } from "./Viewer.tsx";
import { StepChat } from "./Chat.tsx";

interface Props { project: ProjectState; queue: QueueView; onChanged: () => void }

// ---------------------------------------------------------------- step

export function StepDetail({ project, queue, step, onChanged }: Props & { step: StepView }) {
  const id = project.project.id;
  const questions = queue.questions.filter((q) => q.step === step.id);
  const live = (step.status === "running" || step.status === "waiting") && step.session;
  const session = live ? project.sessions.find((s) => s.id === step.session) : undefined;
  const notesOpen = step.status === "pending" || step.status === "stopped";
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
  return (
    <div>
      <div className="text-xs text-zinc-500">
        <span className="font-mono">{queue.id}</span> · {queue.title}
      </div>
      <h2 className="mt-1 flex flex-wrap items-center gap-3 pr-8 text-xl font-semibold text-zinc-50">
        <span className="font-mono text-zinc-500">{step.id}</span> {step.title}
      </h2>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
        <StatusBadge status={step.status} label={reviewLabel(step)} />
        <StepTimes step={step} />
        {step.commit && <span className="font-mono">{step.commit}</span>}
        {session && <span>by {session.title ?? session.id.slice(-8)} ({session.runtime})</span>}
        {stepValuesText(step) && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300" title="This step's own runtime, model and effort; what it leaves out is the run's">
            runs on {stepValuesText(step)}
          </span>
        )}
      </div>
      <StepChat project={id} queue={queue.id} step={step.id} version={project.generated_at} />

      {queue.run?.state === "retry_wait" && queue.run.step === step.id && (
        <div className="mt-4 rounded-lg bg-amber-500/10 p-3 text-sm ring-1 ring-amber-500/30">
          <RetryNote run={queue.run} className="text-sm" />
          {queue.run.reason && <p className="mt-1 text-xs text-zinc-400">{queue.run.reason}</p>}
        </div>
      )}

      {(step.summary || step.reason || step.progress) && (
        <div className="mt-4 rounded-lg bg-zinc-800/50 p-3 text-sm">
          {step.summary && <p><span className="text-zinc-500">Summary: </span>{step.summary}</p>}
          {step.reason && step.status !== "rejected" && <p className="text-orange-300"><span className="text-zinc-500">Reason: </span>{step.reason}</p>}
          {step.progress && step.status === "running" && (
            <p><span className="text-zinc-500">Now: </span>{step.progress.text} <span className="text-xs text-zinc-500">(<TimeAgo at={step.progress.at} />)</span></p>
          )}
        </div>
      )}

      {step.status === "review" && step.review_with === "orchestrator" && (
        <Section title="Waiting for the orchestrator's review">
          <p className="text-sm text-zinc-400">The queue holds here until the orchestrator accepts this step, sends it back, or hands it to you.</p>
        </Section>
      )}
      {showsReviewActions(step) && <AcceptReview project={id} queue={queue.id} step={step.id} next={noteTargets(queue.steps, step.id).next} asked={step.asked_user?.text} criteria={step.acceptance} onChanged={onChanged} />}

      <PushLine project={id} queue={queue} step={step.id} onChanged={onChanged} />

      {step.status === "rejected" && <Rejected step={step} holding={queue.rejection?.step === step.id} />}

      {step.sent_back.length > 0 && (
        <Section title="Sent back">
          <ul className="space-y-2">
            {step.sent_back.map((b) => (
              <li key={b.id} className="text-sm">
                <div className="text-xs text-zinc-500">
                  {b.by === "user" ? "You (Fix it)" : "Orchestrator"} · <TimeAgo at={b.at} /> · {b.to_user ? "beyond the limit: handed to you instead" : b.delivered ? `round ${b.round}` : "on its way to the worker"}
                </div>
                <p className="whitespace-pre-wrap text-zinc-300">{b.text}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {live && session && (
        <Section title="Message the running agent" aside={<span className="text-xs text-zinc-600">read at its next check-in</span>}>
          <Composer
            draft={draftKey(id, "message", queue.id, step.id)}
            placeholder="Delivered to the agent without stopping it…"
            button="Send"
            onSubmit={async (text) => { await act(id, "POST", `/sessions/${enc(session.id)}/messages`, { text, queue: queue.id, step: step.id }); onChanged(); }}
          />
        </Section>
      )}

      {questions.length > 0 && <Section title="Questions">{questions.map((q) => <Question key={q.qid} q={q} project={id} onChanged={onChanged} />)}</Section>}

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
              <li key={i} className="flex gap-2 text-sm text-zinc-300"><span className="text-zinc-600">◇</span><Markdown className="[&_p]:m-0">{a}</Markdown></li>
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
              const caption = <div className="truncate px-2 py-1 text-xs text-zinc-400 group-hover:text-zinc-200">{r.label ?? r.path ?? r.url}{r.round ? ` · round ${r.round}` : ""}</div>;
              const tile = "group overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-left hover:border-zinc-600";
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
                  <div className="flex aspect-video items-center justify-center text-2xl text-zinc-600">{r.url ? "↗" : "▤"}</div>
                  {caption}
                </a>
              );
            })}
          </div>
        </Section>
      )}

      {shown !== undefined && images.length > 0 && (
        <ImageViewer images={images} index={shown} onIndex={(i) => nav.open(`viewer:${i}`)} onClose={() => nav.close("viewer")}
          footer={(i) => <PictureActions key={pictures[i]!.item.path} project={id} queue={queue} step={step} path={pictures[i]!.item.path!} onChanged={onChanged} />} />
      )}

      {step.checks.length > 0 && (
        <Section title="Checks">
          <ul className="space-y-1 text-sm">
            {step.checks.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className={c.ok ? "text-emerald-400" : "text-red-400"}>{c.ok ? "✓" : "✗"}</span>
                <span className="text-zinc-200">{c.name}</span>
                {c.summary && <span className="text-zinc-500">{c.summary}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Notes" aside={<span className="text-xs text-zinc-600">delivered when the step starts</span>}>
        <div className="space-y-2">
          {step.notes.map((n) => (
            <div key={n.id} className="rounded-lg border border-zinc-800 p-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
                <span>from {n.from}</span><TimeAgo at={n.at} />
                <span className={`ml-auto ${n.read_at ? "text-emerald-400" : "text-sky-400"}`}>{n.read_at ? "delivered" : "waiting for the step"}</span>
                {!n.read_at && <WithdrawNote project={id} queue={queue.id} step={step.id} note={n.id} onChanged={onChanged} />}
              </div>
              <Markdown>{n.body}</Markdown>
            </div>
          ))}
          {step.notes.length === 0 && !notesOpen && <p className="text-sm text-zinc-600">None.</p>}
        </div>
        {notesOpen && (
          <div className="mt-3">
            <Composer
              draft={draftKey(id, "note", queue.id, step.id)}
              placeholder={`A note for ${step.id}: the agent reads it when it starts this step…`}
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
              <div key={m.id} className="rounded-lg border border-zinc-800 p-3 text-sm">
                <div className="mb-1 flex gap-2 text-xs text-zinc-500">
                  <span>from {m.from}</span><TimeAgo at={m.at} />
                  <span className={`ml-auto ${m.read_at ? "text-emerald-400" : "text-sky-400"}`}>{m.read_at ? "read" : "not read yet"}</span>
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
          <ol className="relative space-y-2 border-l border-zinc-800 pl-4">
            {step.timeline.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="absolute -left-[3px] mt-1.5 h-1.5 w-1.5 rounded-full bg-zinc-600" />
                <span className="font-mono text-xs text-zinc-500">{e.type}</span>{" "}
                <span className="text-zinc-300">{describe(e)}</span>{" "}
                <span className="text-xs text-zinc-600"><TimeAgo at={e.at} /></span>
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  );
}

/** Reject: the step is marked rejected, the run pauses, nothing is reverted; the orchestrator proposes what follows. */
function RejectStep({ project, queue, step, onChanged }: { project: string; queue: string; step: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!open) return <div className="mt-3"><Button variant="danger" onClick={() => setOpen(true)}>Reject…</Button></div>;
  const reject = () => {
    setBusy(true); setError(undefined);
    act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/reject`, why.trim() ? { text: why } : {})
      .then(() => { setOpen(false); setWhy(""); onChanged(); }, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-3 rounded-lg bg-rose-500/10 p-3 ring-1 ring-rose-500/30">
      <p className="text-sm text-rose-200">Reject this step</p>
      <p className="mt-1 text-xs text-zinc-400">The run pauses and nothing is reverted. The orchestrator is told and proposes what follows (a revert as a step, changed steps, or a new queue) for your approval; the run goes on only once you approve a new revision, and this step is not run again.</p>
      <textarea
        value={why} rows={2} placeholder="Why (optional)…" onChange={(e) => setWhy(e.target.value)}
        className="mt-2 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-rose-500 focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={reject} className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-40">{busy ? "Rejecting…" : "Reject the step"}</button>
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

/** A rejected step: by whom and why, and what the queue waits for while the rejection holds. */
function Rejected({ step, holding }: { step: StepView; holding: boolean }) {
  const at = step.timeline.findLast((e) => e.type === "review.rejected")?.at;
  return (
    <div className="mt-4 rounded-lg bg-rose-500/10 p-3 text-sm ring-1 ring-rose-500/30">
      <p>
        <span className="text-zinc-500">Rejected by you{step.reason ? ": " : ""}</span>
        {step.reason && <span className="text-rose-200">{step.reason}</span>}
        {at && <span className="text-xs text-zinc-500"> · <TimeAgo at={at} /></span>}
      </p>
      <p className="mt-1 text-xs text-zinc-400">
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
  const chip = "rounded bg-black/70 px-1.5 py-0.5 text-[11px]";
  return (
    <span className="absolute right-1.5 top-1.5 flex gap-1">
      {paired && <span className={`${chip} text-zinc-200`} title="Has a before to compare with">⇄</span>}
      {marks?.accepted && <span className={`${chip} text-emerald-300`} title="You marked it accepted">✓</span>}
      {!!marks?.comments.length && <span className={`${chip} text-sky-300`} title="Your comments">💬 {marks.comments.length}</span>}
    </span>
  );
}

/**
 * Below a picture in the viewer: mark it accepted (a mark only; the step is not accepted) and comment on it. A comment
 * goes back to the worker as a Fix it while the step waits for the user's review; otherwise it is a note on the next
 * pending step.
 */
function PictureActions({ project, queue, step, path, onChanged }: { project: string; queue: QueueView; step: StepView; path: string; onChanged: () => void }) {
  const marks = step.pictures[path];
  const [error, setError] = useState<string>();
  const next = noteTargets(queue.steps, step.id).next;
  const where = showsReviewActions(step) ? "goes back to the worker with the step (a Fix it: your words win over its criteria)"
    : next ? `becomes a note on step ${next}, delivered when it starts` : undefined;
  const base = `/queues/${enc(queue.id)}/steps/${enc(step.id)}/pictures`;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => act(project, "POST", `${base}/mark`, { path, accepted: !marks?.accepted }).then(onChanged, (e: Error) => setError(e.message))}
          aria-pressed={!!marks?.accepted}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ring-1 ${marks?.accepted ? "bg-emerald-600/20 text-emerald-300 ring-emerald-500/50" : "text-zinc-200 ring-white/15 hover:bg-white/10"}`}
        >{marks?.accepted ? "✓ Accepted" : "Mark accepted"}</button>
        <span className="text-xs text-zinc-500">a mark for this picture; the step is not accepted by it</span>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      {marks?.comments.map((c, i) => (
        <div key={i} className="rounded-md bg-white/5 px-2 py-1.5">
          <p className="whitespace-pre-wrap text-zinc-200">{c.text}</p>
          <p className="text-[11px] text-zinc-500">{c.to === "send_back" ? "sent back to the worker" : `a note on step ${c.note_step}`} · <TimeAgo at={c.at} /></p>
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
          <p className="mt-1 text-[11px] text-zinc-500">The comment {where}.</p>
        </div>
      ) : <p className="text-xs text-zinc-500">No step to take a comment: this step is not waiting for your review and nothing after it is pending.</p>}
    </div>
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
    <Section title="Commits" aside={foreign ? <span className="text-xs text-amber-400/80">◆ not by this step's worker</span> : undefined}>
      <div className="space-y-3">
        {data.rounds.map((r, i) => (
          <div key={i}>
            {several && <div className="mb-1 text-xs text-zinc-500">Round {i + 1}{r.open ? " (at work)" : ""}</div>}
            {r.commits.length === 0
              ? <p className="text-sm text-zinc-500">{r.open ? "No commit yet." : "No commit."}</p>
              : (
                <ul className="space-y-1.5">
                  {r.commits.map((c) => (
                    <li key={c.sha} className="text-sm">
                      <div className="flex gap-2">
                        <span className="shrink-0 font-mono text-xs leading-5 text-zinc-500">{c.sha.slice(0, 7)}</span>
                        <span className={`min-w-0 ${c.foreign ? "text-amber-200" : "text-zinc-200"}`}>{c.foreign && <span className="text-amber-400" title="Not made in a turn of this step's worker">◆ </span>}{c.subject}</span>
                      </div>
                      <div className="pl-[3.75rem] text-xs text-zinc-500">
                        {c.files} file{c.files === 1 ? "" : "s"} · <span className="text-emerald-400/80">+{c.insertions}</span> <span className="text-red-400/80">−{c.deletions}</span> · {c.author} · <TimeAgo at={c.at} />
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
      <p className="break-all text-xs text-zinc-500"><span className="font-mono">{queue.worktree}</span> on <span className="font-mono">{branch}</span>{g?.base ? <> from <span className="font-mono">{g.base.ref}</span></> : null}</p>
      {g?.merged && <p className="mt-1.5 text-sm text-emerald-300">Merged into <span className="font-mono">{g.merged.into}</span> ({g.merged.fast_forward ? "fast-forward" : `merge commit ${g.merged.sha.slice(0, 7)}`}) <span className="text-xs text-zinc-500">· <TimeAgo at={g.merged.at} /></span></p>}
      {g?.cleaned
        ? <p className="mt-1.5 text-sm text-zinc-300">Cleaned up: the worktree removed, branch <span className="font-mono">{g.cleaned.branch}</span> deleted <span className="text-xs text-zinc-500">· <TimeAgo at={g.cleaned.at} /></span></p>
        : (
          <div className="mt-2 flex flex-wrap gap-2">
            {base && !g?.merged && <Button variant="quiet" onClick={() => { setAsk("merge"); setResult(undefined); }}>Merge into {base}…</Button>}
            <Button variant="quiet" onClick={() => { setAsk("cleanup"); setResult(undefined); }}>Clean up…</Button>
          </div>
        )}
      {ask && !g?.cleaned && (
        <div className="mt-3 rounded-lg bg-amber-500/10 p-3 ring-1 ring-amber-500/30">
          {ask === "merge" ? (
            <>
              <p className="text-sm text-amber-200">Merge <span className="font-mono">{branch}</span> into <span className="font-mono">{base}</span>?</p>
              <p className="mt-1 text-xs text-zinc-400">In the worktree where {base} is checked out: a fast-forward when possible, else a merge commit. Refused if that worktree has uncommitted changes or a run is going there; on a conflict the merge is aborted and nothing changes. Nothing is pushed.</p>
            </>
          ) : (
            <>
              <p className="text-sm text-amber-200">Clean up this queue's worktree?</p>
              <p className="mt-1 text-xs text-zinc-400">Removes the worktree (git worktree remove) and deletes branch <span className="font-mono">{branch}</span> (git branch -d). Refused, with nothing removed, if the worktree has uncommitted changes or the branch is not merged.</p>
            </>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => go(ask)}>{busy ? "Working…" : ask === "merge" ? "Merge" : "Clean up"}</Button>
            <Button variant="quiet" onClick={() => setAsk(undefined)}>Cancel</Button>
          </div>
        </div>
      )}
      {result && <p className={`mt-2 break-all text-xs ${result.ok ? "text-emerald-300" : "text-red-300"}`}>{result.text}</p>}
    </Section>
  );
}

interface BranchView { branch: string; base?: { ref: string; ahead: number; behind: number }; upstream?: { ref: string; ahead: number; behind: number; at?: string } }

/** The queue's branch: ahead and behind of its base and of its remote-tracking ref (as last fetched: never fetched here). */
function BranchLine({ project, queue, version }: { project: string; queue: string; version: unknown }) {
  const b = useFetch<BranchView | null>(`/api/projects/${enc(project)}/queues/${enc(queue)}/git`, version);
  if (!b) return null;
  const counts = (x: { ahead: number; behind: number }) => (
    <span><span className="text-emerald-300">{x.ahead} ahead</span>, <span className={x.behind ? "text-amber-300" : "text-zinc-400"}>{x.behind} behind</span></span>
  );
  return (
    <div className="mt-3 space-y-0.5 rounded-lg bg-zinc-800/50 p-3 text-sm text-zinc-300">
      <p><span className="text-zinc-500">Branch </span><span className="font-mono">{b.branch}</span></p>
      {b.base && <p className="text-xs">{counts(b.base)} <span className="text-zinc-500">of its base</span> <span className="font-mono">{b.base.ref}</span></p>}
      {b.upstream
        ? <p className="text-xs">{counts(b.upstream)} <span className="text-zinc-500">of</span> <span className="font-mono">{b.upstream.ref}</span> <span className="text-zinc-500">as fetched {b.upstream.at ? <TimeAgo at={b.upstream.at} /> : "at an unknown time"}</span></p>
        : <p className="text-xs text-zinc-500">No remote-tracking branch.</p>}
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
    <div className={`mt-4 rounded-lg p-3 text-sm ring-1 ${failed ? "bg-red-500/10 ring-red-500/30" : p.result === "pushed" ? "bg-emerald-500/10 ring-emerald-500/30" : "bg-zinc-800/50 ring-zinc-700"}`}>
      <p>
        <span className="text-zinc-500">{failed ? "Push failed: " : p.result === "pushed" ? "Pushed: " : "Push: "}</span>
        <span className={failed ? "text-red-300" : "text-zinc-200"}>{p.text}</span>
        <span className="text-xs text-zinc-500"> · <TimeAgo at={p.at} /></span>
      </p>
      {failed && <p className="mt-1 text-xs text-zinc-400">The step stays accepted. The next accepted step pushes again, or push again now.</p>}
      {latest && (
        <div className="mt-2 flex items-center gap-3">
          <Button variant="quiet" disabled={busy} onClick={() => { setBusy(true); setError(undefined); act(project, "POST", `/queues/${enc(queue.id)}/push`).then(onChanged, (e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>{busy ? "Pushing…" : "Push again"}</Button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      )}
    </div>
  );
}

const POLICY_LABEL: Record<string, string> = { continue: "go on", wait: "wait for my review", orchestrator: "the orchestrator reviews" };

function AcceptReview({ project, queue, step, next, asked, criteria, onChanged }: { project: string; queue: string; step: string; next?: string; asked?: string; criteria: string[]; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  // Accept's note: collapsed by default; empty means a plain accept. It goes to the next step, or to the orchestrator
  // (always on the queue's last step).
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteTo, setNoteTo] = useState<"next" | "orchestrator">("next");
  const to = next ? noteTo : "orchestrator";
  const accept = () => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/accept`, note.trim() ? { text: note, note_to: to } : {})
    .then(() => { setNote(""); setNoteOpen(false); onChanged(); }, (e: Error) => setError(e.message));
  // Fix it with criteria: the text waits here until the user confirms that it overrides them.
  const [confirm, setConfirm] = useState<{ resolve: () => void; reject: (e: Error) => void; send: () => Promise<void> }>();
  const send = (text: string) => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/send-back`, { text }).then(onChanged);
  return (
    <Section title="Waiting for your review">
      {asked && <p className="mb-2 text-sm text-zinc-300"><span className="text-zinc-500">The orchestrator asks you: </span>{asked}</p>}
      <p className="mb-2 text-sm text-zinc-400">The queue holds here until you accept this step or send it back.</p>
      {noteOpen && (
        <div className="mb-3">
          <textarea
            value={note} rows={3} placeholder="A note with your acceptance (optional)…" onChange={(e) => setNote(e.target.value)}
            className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
          {next ? (
            <label className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              The note goes to
              <select value={noteTo} onChange={(e) => setNoteTo(e.target.value as "next" | "orchestrator")} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200">
                <option value="next">the next step ({next}), when it starts</option>
                <option value="orchestrator">the orchestrator (the plan, later queues, the rules)</option>
              </select>
            </label>
          ) : (
            <p className="mt-1.5 text-xs text-zinc-400">The note goes to the orchestrator: this is the queue's last step.</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void accept()}>{note.trim() ? "Accept with the note" : "Accept and go on"}</Button>
        {!noteOpen && <button onClick={() => setNoteOpen(true)} className="text-sm text-zinc-400 hover:text-zinc-200">+ Add a note</button>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <RejectStep project={project} queue={queue} step={step} onChanged={onChanged} />
      <div className="mt-4">
        <p className="mb-1.5 text-sm text-zinc-300">Fix it</p>
        <p className="mb-2 text-xs text-zinc-500">Sends the step back to its worker with your words. Where they conflict with the step's acceptance criteria, your words win.</p>
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
          <div className="mt-3 rounded-lg bg-amber-500/10 p-3 ring-1 ring-amber-500/30">
            <p className="text-sm text-amber-200">Your words override these acceptance criteria where they conflict:</p>
            <ul className="mt-1.5 space-y-1">
              {criteria.map((c, i) => <li key={i} className="flex gap-2 text-sm text-zinc-300"><span className="text-zinc-600">◇</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => { const c = confirm; setConfirm(undefined); c.send().then(c.resolve, c.reject); }}>Send it back</Button>
              <Button variant="quiet" onClick={() => { const c = confirm; setConfirm(undefined); c.reject(new Error("Not sent; your text is kept.")); }}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

function WithdrawNote({ project, queue, step, note, onChanged }: { project: string; queue: string; step: string; note: string; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  return (
    <>
      {error && <span className="text-red-400">{error}</span>}
      <button
        className="text-zinc-500 hover:text-red-300"
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

export function Question({ q, project, onChanged }: { q: QuestionView; project: string; onChanged: () => void }) {
  const open = q.state === "open" || q.state === "escalated";
  const tone = q.state === "escalated" ? "border-violet-500/40 bg-violet-500/5" : open ? "border-amber-500/30 bg-amber-500/5" : "border-zinc-800";
  return (
    <div className={`mb-2 rounded-lg border p-3 text-sm ${tone}`}>
      <div className="mb-1 flex flex-wrap gap-2 text-xs text-zinc-500">
        <StatusBadge status={q.state === "open" ? "waiting" : q.state === "escalated" ? "review" : "done"} label={q.state === "escalated" ? "for you" : q.state} />
        {q.queue && <span className="font-mono">{q.queue}{q.step ? `/${q.step}` : ""}</span>}
        <span>{q.can_continue ? "the worker goes on meanwhile" : "the worker waits"}</span>
        <span className="ml-auto"><TimeAgo at={q.asked_at} /></span>
      </div>
      <p className="text-zinc-100">{q.text}</p>
      {q.options && <ul className="mt-1 list-disc pl-5 text-zinc-400">{q.options.map((o) => <li key={o}>{o}</li>)}</ul>}
      {q.answers.map((a) => (
        <div key={a.id} className="mt-2 border-t border-zinc-800 pt-2 text-zinc-300">
          <span className="text-zinc-500">{a.escalate ? "Passed to you by the orchestrator: " : `Answer (${a.by}): `}</span>
          <Markdown className="inline [&_p]:inline [&_p]:m-0">{a.text}</Markdown>
        </div>
      ))}
      {open && (
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
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          <input type="checkbox" checked={goOn} onChange={(e) => setGoOn(e.target.checked)} className="accent-sky-500" />
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
function StopBox({ project, queue, onChanged }: { project: string; queue: QueueView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setBusy(true); setError(undefined);
    try { await act(project, "POST", `/queues/${enc(queue.id)}/continue`); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const p = queue.lift_proposal;
  return (
    <div className="mt-4 rounded-lg bg-orange-500/10 p-3 text-sm ring-1 ring-orange-500/30">
      <p className="font-medium text-orange-300">Stopped{stopPlace(queue)}</p>
      {queue.status_reason && <div className="mt-1 text-zinc-300"><Expandable text={queue.status_reason} /></div>}
      {p && (
        <div className="mt-3 rounded-md bg-zinc-900/70 p-2.5">
          <p className="text-xs text-zinc-500">The orchestrator proposes to continue · <TimeAgo at={p.at} /></p>
          <p className="mt-0.5 text-zinc-200">{p.reason}</p>
        </div>
      )}
      {queue.approved ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => void go()}>Continue</Button>
          <span className="text-xs text-zinc-400">Lifts the stop; the stopped step runs again in its session, unless it was skipped.</span>
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-400">Revision {queue.revision} is not approved yet: approving it lifts the stop.</p>
      )}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
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
      default: return c.step ? `${c.step}: ${c.from} → ${c.to}` : `queue ${queue.id}: ${c.from} → ${c.to}`;
    }
  };
  return (
    <Section title="Changes">
      <ul className="space-y-2">
        {[...entries].reverse().map((c, i) => (
          <li key={i} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-zinc-500">
              <span className={c.by === "orchestrator" ? "text-violet-300" : "text-sky-300"}>{WHO[c.by]}</span>
              <TimeAgo at={c.at} />
            </div>
            <div className="text-zinc-200">{what(c)}</div>
            {c.reason && <div className="text-xs text-zinc-400">{c.kind === "lift" ? "The stop was: " : "Why: "}{c.reason}</div>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function WithdrawApproval({ project, queue, onChanged }: { project: string; queue: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <div className="mt-2"><Button variant="quiet" onClick={() => setOpen(true)}>Withdraw approval</Button></div>;
  return (
    <div className="mt-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
      <p className="mb-2 text-sm text-zinc-300">
        The queue has not started. Withdrawing puts it back to proposed: it waits for your approval again and cannot be started until then. The earlier approval stays on record.
      </p>
      <Composer
        rows={2}
        allowEmpty
        draft={draftKey(project, "withdraw", queue)}
        placeholder="Why (optional)…"
        button="Withdraw approval"
        extra={<Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>}
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
            <span className="font-mono text-zinc-500">{s.id}</span>
            <span className="text-zinc-300">{s.title}</span>
            <span className="text-violet-300">⚙ {stepValuesText(s)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-zinc-500">The other steps, and what a step leaves out, run on the run's runtime, model and effort.</p>
    </Section>
  );
}

export function QueueDetail({ project, queue, onChanged }: Props) {
  const id = project.project.id;
  const latest = queue.approvals.at(-1);
  const inherited = project.project.defaults.stop_conditions;
  const [error, setError] = useState<string>();
  const setPolicy = (review_policy: string | null) =>
    act(id, "PATCH", `/queues/${enc(queue.id)}`, { review_policy }).then(onChanged, (e: Error) => setError(e.message));

  return (
    <div>
      <div className="text-xs text-zinc-500">{project.project.name}</div>
      <h2 className="mt-1 pr-8 text-xl font-semibold text-zinc-50">
        <span className="font-mono text-zinc-500">{queue.id}</span> {queue.title}
      </h2>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
        <StatusBadge status={queue.status} />
        <span>revision {queue.revision}</span>
        {queue.branch && <span className="font-mono">{queue.branch}</span>}
        {queue.worktree && <span className="font-mono">{queue.worktree}</span>}
        <span className={queue.approved ? "text-emerald-400" : "text-zinc-500"}>
          {queue.approved ? "approved" : queue.withdrawals.length && queue.withdrawals.at(-1)!.approvals >= queue.approvals.length ? "approval withdrawn" : latest ? "approval is for an older revision" : "no approval recorded in Nexus"}
        </span>
      </div>

      <BranchLine project={id} queue={queue.id} version={project.generated_at} />
      <WorktreeActions project={id} root={project.project.root} queue={queue} onChanged={onChanged} />

      {queue.status === "stopped"
        ? <StopBox project={id} queue={queue} onChanged={onChanged} />
        : queue.status_reason && <Section title="State"><Expandable text={queue.status_reason} /></Section>}
      {queue.report && (
        <Section title="Queue report">
          <p className="text-sm text-zinc-300">{queue.report.summary}</p>
          <a className="text-sm text-sky-400 underline" href={fileUrl(id, queue.report.path)} target="_blank" rel="noreferrer">Open the report</a>
        </Section>
      )}
      {queue.questions.length > 0 && <Section title="Questions">{queue.questions.map((q) => <Question key={q.qid} q={q} project={id} onChanged={onChanged} />)}</Section>}

      <OwnValues queue={queue} />

      <Section title="Approval">
        {[...queue.approvals.map((a) => ({ ...a, withdrawn: false as const })), ...queue.withdrawals.map((w) => ({ ...w, withdrawn: true as const }))]
          .sort((x, y) => x.at.localeCompare(y.at))
          .map((a, i) => (
            <p key={i} className={`mb-1 text-sm ${a.withdrawn ? "text-orange-300/90" : "text-zinc-300"}`}>
              r{a.revision} · {a.withdrawn ? "withdrawn " : ""}<TimeAgo at={a.at} />
              {!a.withdrawn && a.words && <> · <q className="italic">{a.words}</q></>}
              {a.withdrawn && a.reason && <> · <q className="italic">{a.reason}</q></>}
            </p>
          ))}
        {queue.approved && !queue.run && queue.steps.every((s) => s.status === "pending" && s.segments.length === 0) && (
          <WithdrawApproval project={id} queue={queue.id} onChanged={onChanged} />
        )}
        {!queue.approved && (
          <div className="mt-2">
            <p className="mb-2 text-sm text-zinc-400">
              Approving pins revision {queue.revision}: its steps, acceptance criteria, checks and stop conditions. A later change needs a new approval.
            </p>
            <Composer
              rows={2}
              allowEmpty
              draft={draftKey(id, "approval", queue.id)}
              placeholder="Your words with the approval (optional)…"
              button={`Approve revision ${queue.revision}`}
              onSubmit={async (words) => { await act(id, "POST", `/queues/${enc(queue.id)}/approve`, { words }); onChanged(); }}
            />
          </div>
        )}
      </Section>

      <RunControls project={project} queue={queue} onChanged={onChanged} />

      <Changes entries={queue.changes} queue={queue} />

      <Section title="Settings">
        <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
          After each step
          <select
            value={queue.review_policy ?? ""}
            onChange={(e) => void setPolicy(e.target.value || null)}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
          >
            <option value="">project default ({POLICY_LABEL[project.project.defaults.review_policy]})</option>
            <option value="continue">go on to the next step</option>
            <option value="wait">wait for my review</option>
            <option value="orchestrator">wait for the orchestrator's review</option>
          </select>
        </label>
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </Section>

      {queue.description && <Section title="Description"><Expandable text={queue.description} lines={6} /></Section>}

      <Section title="Stop conditions">
        <ul className="space-y-1.5 text-sm text-zinc-300">
          {queue.stop_conditions.map((c, i) => <li key={i} className="flex gap-2"><span className="text-orange-400/70">■</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
          {inherited.map((c, i) => <li key={`p${i}`} className="flex gap-2 text-zinc-500"><span>□</span><span>{c} <span className="text-xs">(project)</span></span></li>)}
          {queue.stop_conditions.length + inherited.length === 0 && <li className="text-zinc-600">None.</li>}
        </ul>
      </Section>
      {queue.checks.length > 0 && (
        <Section title="Checks for every step">
          {queue.checks.map((c, i) => <Markdown key={i}>{c}</Markdown>)}
        </Section>
      )}
      {queue.source && (
        <p className="mt-6 text-xs text-zinc-600">Imported from <span className="font-mono">{queue.source.path}</span> <TimeAgo at={queue.source.imported_at} /></p>
      )}
    </div>
  );
}
