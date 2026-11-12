import { useState } from "react";
import type { Event } from "@nexus/protocol";
import { act, enc, fileUrl, type ProjectState, type QuestionView, type QueueView, type StepView } from "../api.ts";
import { Button, Composer, Expandable, Markdown, Section, StatusBadge, TimeAgo } from "./ui.tsx";
import { Activity, RunControls } from "./Run.tsx";

interface Props { project: ProjectState; queue: QueueView; onChanged: () => void }

// ---------------------------------------------------------------- step

export function StepDetail({ project, queue, step, onChanged }: Props & { step: StepView }) {
  const id = project.project.id;
  const questions = queue.questions.filter((q) => q.step === step.id);
  const live = (step.status === "running" || step.status === "waiting") && step.session;
  const session = live ? project.sessions.find((s) => s.id === step.session) : undefined;
  const notesOpen = step.status === "pending" || step.status === "stopped";
  return (
    <div>
      <div className="text-xs text-zinc-500">
        <span className="font-mono">{queue.id}</span> · {queue.title}
      </div>
      <h2 className="mt-1 flex flex-wrap items-center gap-3 pr-8 text-xl font-semibold text-zinc-50">
        <span className="font-mono text-zinc-500">{step.id}</span> {step.title}
      </h2>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
        <StatusBadge status={step.status} />
        {step.started_at && <span>started <TimeAgo at={step.started_at} /></span>}
        {step.finished_at && <span>finished <TimeAgo at={step.finished_at} /></span>}
        {step.commit && <span className="font-mono">{step.commit}</span>}
        {session && <span>by {session.title ?? session.id.slice(-8)} ({session.runtime})</span>}
      </div>

      {(step.summary || step.reason || step.progress) && (
        <div className="mt-4 rounded-lg bg-zinc-800/50 p-3 text-sm">
          {step.summary && <p><span className="text-zinc-500">Summary: </span>{step.summary}</p>}
          {step.reason && <p className="text-orange-300"><span className="text-zinc-500">Reason: </span>{step.reason}</p>}
          {step.progress && step.status === "running" && (
            <p><span className="text-zinc-500">Now: </span>{step.progress.text} <span className="text-xs text-zinc-500">(<TimeAgo at={step.progress.at} />)</span></p>
          )}
        </div>
      )}

      {step.status === "review" && <AcceptReview project={id} queue={queue.id} step={step.id} onChanged={onChanged} />}

      {live && session && (
        <Section title="Message the running agent" aside={<span className="text-xs text-zinc-600">read at its next check-in</span>}>
          <Composer
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
              const img = r.path && /\.(png|jpe?g|gif|webp|svg)$/i.test(r.path);
              return (
                <a key={i} href={href} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 hover:border-zinc-600">
                  {img ? <img src={href} alt={r.label ?? ""} className="aspect-video w-full object-cover" loading="lazy" />
                    : <div className="flex aspect-video items-center justify-center text-2xl text-zinc-600">{r.url ? "↗" : "▤"}</div>}
                  <div className="truncate px-2 py-1 text-xs text-zinc-400 group-hover:text-zinc-200">{r.label ?? r.path ?? r.url}{r.round ? ` · round ${r.round}` : ""}</div>
                </a>
              );
            })}
          </div>
        </Section>
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

function AcceptReview({ project, queue, step, onChanged }: { project: string; queue: string; step: string; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  return (
    <Section title="Waiting for your review">
      <p className="mb-2 text-sm text-zinc-400">The queue holds here until you accept this step.</p>
      <Button onClick={() => act(project, "POST", `/queues/${enc(queue)}/steps/${enc(step)}/accept`).then(onChanged, (e: Error) => setError(e.message))}>Accept and go on</Button>
      {error && <span className="ml-3 text-xs text-red-400">{error}</span>}
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
          {queue.approved ? "approved" : latest ? "approval is for an older revision" : "no approval recorded in Nexus"}
        </span>
      </div>

      {queue.status_reason && <Section title="State"><Expandable text={queue.status_reason} /></Section>}
      {queue.report && (
        <Section title="Queue report">
          <p className="text-sm text-zinc-300">{queue.report.summary}</p>
          <a className="text-sm text-sky-400 underline" href={fileUrl(id, queue.report.path)} target="_blank" rel="noreferrer">Open the report</a>
        </Section>
      )}
      {queue.questions.length > 0 && <Section title="Questions">{queue.questions.map((q) => <Question key={q.qid} q={q} project={id} onChanged={onChanged} />)}</Section>}

      <Section title="Approval">
        {queue.approvals.map((a, i) => (
          <p key={i} className="mb-1 text-sm text-zinc-300">
            r{a.revision} · <TimeAgo at={a.at} />{a.words && <> · <q className="italic">{a.words}</q></>}
          </p>
        ))}
        {!queue.approved && (
          <div className="mt-2">
            <p className="mb-2 text-sm text-zinc-400">
              Approving pins revision {queue.revision}: its steps, acceptance criteria, checks and stop conditions. A later change needs a new approval.
            </p>
            <Composer
              rows={2}
              allowEmpty
              placeholder="Your words with the approval (optional)…"
              button={`Approve revision ${queue.revision}`}
              onSubmit={async (words) => { await act(id, "POST", `/queues/${enc(queue.id)}/approve`, { words }); onChanged(); }}
            />
          </div>
        )}
      </Section>

      <RunControls project={project} queue={queue} onChanged={onChanged} />

      <Section title="Settings">
        <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
          After each step
          <select
            value={queue.review_policy ?? ""}
            onChange={(e) => void setPolicy(e.target.value || null)}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
          >
            <option value="">project default ({project.project.defaults.review_policy === "wait" ? "wait for review" : "go on"})</option>
            <option value="continue">go on to the next step</option>
            <option value="wait">wait for my review</option>
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
