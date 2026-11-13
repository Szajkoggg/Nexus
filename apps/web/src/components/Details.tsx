import { useState } from "react";
import type { Event, StatusChange } from "@nexus/protocol";
import { stopPlace } from "@nexus/protocol/attention";
import { act, enc, fileUrl, type ProjectState, type QuestionView, type QueueView, type StepView } from "../api.ts";
import { Button, Composer, Expandable, Markdown, Section, StatusBadge, StepTimes, TimeAgo, reviewLabel } from "./ui.tsx";
import { Activity, RetryNote, RunControls } from "./Run.tsx";
import { StepRefusals } from "./Refusals.tsx";
import { draftKey } from "../drafts.ts";
import { layerValue } from "../layers.ts";
import { nav, useNav } from "../nav.ts";
import { ImageViewer, type ViewerImage } from "./Viewer.tsx";

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
  const images: ViewerImage[] = step.review_items.filter(isImage)
    .map((r) => ({ src: fileUrl(id, r.path!), label: r.label ?? r.path!.split("/").at(-1)!, round: r.round }));
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
        {(step.runtime || step.model || step.effort) && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300" title="This step's own runtime, model and effort; what it leaves out is the run's">
            runs on {[step.runtime === "codex" ? "Codex" : step.runtime === "claude" ? "Claude Code" : undefined, step.model, step.effort && `${step.effort} effort`].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>

      {queue.run?.state === "retry_wait" && queue.run.step === step.id && (
        <div className="mt-4 rounded-lg bg-amber-500/10 p-3 text-sm ring-1 ring-amber-500/30">
          <RetryNote run={queue.run} className="text-sm" />
          {queue.run.reason && <p className="mt-1 text-xs text-zinc-400">{queue.run.reason}</p>}
        </div>
      )}

      {(step.summary || step.reason || step.progress) && (
        <div className="mt-4 rounded-lg bg-zinc-800/50 p-3 text-sm">
          {step.summary && <p><span className="text-zinc-500">Summary: </span>{step.summary}</p>}
          {step.reason && <p className="text-orange-300"><span className="text-zinc-500">Reason: </span>{step.reason}</p>}
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
      {step.status === "review" && step.review_with !== "orchestrator" && <AcceptReview project={id} queue={queue.id} step={step.id} asked={step.asked_user?.text} criteria={step.acceptance} onChanged={onChanged} />}

      <PushLine project={id} queue={queue} step={step.id} onChanged={onChanged} />

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
                  <button key={i} onClick={() => nav.open(`viewer:${n}`)} className={tile}>
                    <img src={href} alt={r.label ?? ""} className="aspect-video w-full object-cover" loading="lazy" />
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
        <ImageViewer images={images} index={shown} onIndex={(i) => nav.open(`viewer:${i}`)} onClose={() => nav.close("viewer")} />
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

function AcceptReview({ project, queue, step, asked, criteria, onChanged }: { project: string; queue: string; step: string; asked?: string; criteria: string[]; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  // Fix it with criteria: the text waits here until the user confirms that it overrides them.
  const [confirm, setConfirm] = useState<{ resolve: () => void; reject: (e: Error) => void; send: () => Promise<void> }>();
  const send = (text: string) => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/send-back`, { text }).then(onChanged);
  return (
    <Section title="Waiting for your review">
      {asked && <p className="mb-2 text-sm text-zinc-300"><span className="text-zinc-500">The orchestrator asks you: </span>{asked}</p>}
      <p className="mb-2 text-sm text-zinc-400">The queue holds here until you accept this step or send it back.</p>
      <Button onClick={() => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/accept`).then(onChanged, (e: Error) => setError(e.message))}>Accept and go on</Button>
      {error && <span className="ml-3 text-xs text-red-400">{error}</span>}
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
