import type { Event } from "@nexus/protocol";
import { fileUrl, type ProjectState, type QuestionView, type QueueView, type StepView } from "../api.ts";
import { Expandable, Markdown, Section, StatusBadge, TimeAgo } from "./ui.tsx";

// ---------------------------------------------------------------- step

export function StepDetail({ project, queue, step }: { project: ProjectState; queue: QueueView; step: StepView }) {
  const id = project.project.id;
  const questions = queue.questions.filter((q) => q.step === step.id);
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

      {questions.length > 0 && <Section title="Questions">{questions.map((q) => <Question key={q.qid} q={q} />)}</Section>}

      <Section title="Notes" aside={<span className="text-xs text-zinc-600">delivered when the step starts</span>}>
        {step.notes.length === 0 && <p className="text-sm text-zinc-600">None. (Adding notes from the dashboard comes in phase 2; for now: <code className="text-zinc-400">nexus note {queue.id} {step.id} "…"</code>)</p>}
        <div className="space-y-2">
          {step.notes.map((n) => (
            <div key={n.id} className="rounded-lg border border-zinc-800 p-3">
              <div className="mb-1 flex gap-2 text-xs text-zinc-500">
                <span>from {n.from}</span><TimeAgo at={n.at} />
                <span className={`ml-auto ${n.read_at ? "text-emerald-400" : "text-sky-400"}`}>{n.read_at ? "read" : "not yet delivered"}</span>
              </div>
              <Markdown>{n.body}</Markdown>
            </div>
          ))}
        </div>
      </Section>

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

function Question({ q }: { q: QuestionView }) {
  return (
    <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <div className="mb-1 flex gap-2 text-xs text-zinc-500">
        <StatusBadge status={q.state === "open" ? "waiting" : q.state === "escalated" ? "review" : "done"} label={q.state} />
        {q.can_continue && <span>· worker continues meanwhile</span>}
        <span className="ml-auto"><TimeAgo at={q.asked_at} /></span>
      </div>
      <p className="text-zinc-100">{q.text}</p>
      {q.options && <ul className="mt-1 list-disc pl-5 text-zinc-400">{q.options.map((o) => <li key={o}>{o}</li>)}</ul>}
      {q.answers.map((a, i) => (
        <p key={i} className="mt-2 border-t border-zinc-800 pt-2 text-zinc-300">
          <span className="text-zinc-500">{a.escalate ? "Escalated: " : "Answer: "}</span>{a.text}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- queue

export function QueueDetail({ project, queue }: { project: ProjectState; queue: QueueView }) {
  const latest = queue.approvals.at(-1);
  const inherited = project.project.defaults.stop_conditions;
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
          <a className="text-sm text-sky-400 underline" href={fileUrl(project.project.id, queue.report.path)} target="_blank" rel="noreferrer">Open the report</a>
        </Section>
      )}
      {queue.approvals.length > 0 && (
        <Section title="Approvals">
          {queue.approvals.map((a, i) => (
            <p key={i} className="text-sm text-zinc-300">r{a.revision} · <TimeAgo at={a.at} />{a.words && <> · <q className="italic">{a.words}</q></>}</p>
          ))}
        </Section>
      )}
      {queue.questions.length > 0 && <Section title="Questions">{queue.questions.map((q) => <Question key={q.qid} q={q} />)}</Section>}
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
