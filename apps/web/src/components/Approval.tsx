// Approving a queue (UX proposals, 15; 13 left): the whole queue in one scroll. Two forms of the same approval: the full
// view (a desktop opens a queue that waits for approval in it, from the waiting item and from the queue: an outline on
// the left, every step's goal and acceptance in the page, the run settings on one line under the title), and the
// compact list with expandable criteria (the queue's drawer, and the phone). Both: the orchestrator's message one
// click away, "Ask the orchestrator…" (the chat opens with the queue referenced in the composer), and "Approve revision
// N" in the action bar with what it pins; Ctrl+Enter approves. A stopped queue's revision keeps SC2's Keep or Discard.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ChatEntry } from "@nexus/protocol";
import { actResult, enc, type ProjectState, type QueueView, type StepView } from "../api.ts";
import { draftOf, pinsText, queueReference, runSettings, withReference } from "../approval.ts";
import { draftKey, putDraft, readDraft } from "../drafts.ts";
import { nav } from "../nav.ts";
import { queueStatus } from "../queueStatus.ts";
import { needsWorkChoice, stopDecision, type LeftState, type WorkChoice } from "../stopDecision.ts";
import { ActionBar, Button, CloseButton, Markdown, TEXTAREA, TimeAgo, useDraftText, type MenuEntry } from "./ui.tsx";
import { StopBox, stopVersion, useLeft } from "./Stop.tsx";

// ---------------------------------------------------------------- which form

export type ApprovalForm = "full" | "panel";
const forms = new Map<string, ApprovalForm>();
const formListeners = new Set<() => void>();
const formKey = (project: string, queue: string, revision: number) => `${project}/${queue}/${revision}`;

/**
 * The form the user picked for a queue's approval (the full view's "Show as a panel", the compact list's "Full view"),
 * for this revision and as long as the page lives; undefined until they pick one: then a desktop shows the full view,
 * a phone the compact list.
 */
export function useApprovalForm(project: string | undefined, queue: string | undefined, revision: number | undefined): [ApprovalForm | undefined, (f: ApprovalForm) => void] {
  const key = project && queue && revision ? formKey(project, queue, revision) : "";
  const form = useSyncExternalStore((l) => { formListeners.add(l); return () => formListeners.delete(l); }, () => forms.get(key));
  return [form, (f) => { if (!key) return; forms.set(key, f); for (const l of formListeners) l(); }];
}

// ---------------------------------------------------------------- the approval itself

/**
 * The approval of a queue's current revision, shared by both forms: the words with it (a draft), Keep or Discard of a
 * stopped queue (stopDecision), the button's words and whether it waits, and the hint with what approving pins.
 */
export function useApprove({ project, queue, left, work, onChanged }: {
  project: string; queue: QueueView; left: LeftState; work?: WorkChoice; onChanged: () => void;
}) {
  const stopped = queue.status === "stopped";
  const d = stopped ? stopDecision({ approved: queue.approved, revision: queue.revision, left, work }) : undefined;
  const needsChoice = d?.needsChoice ?? false;
  const wordsKey = draftKey(project, "approval", queue.id);
  const [wordsOpen, setWordsOpen] = useState(() => !!readDraft(wordsKey));
  const [note, setNote] = useState<string>();
  const words = useDraftText({
    draft: wordsKey, allowEmpty: true,
    onSubmit: async (text) => {
      if (needsChoice && !work) throw new Error("choose Keep or Discard first, in the stop box");
      const r = await actResult<{ message?: string }>(project, "POST", `/queues/${enc(queue.id)}/approve`, { words: text, work: needsChoice ? work : undefined });
      if (r?.message) setNote(r.message);
      onChanged();
    },
  });
  const disabled = !words.ready || !!d?.approve?.disabled;
  return {
    words, wordsOpen, setWordsOpen, note, disabled,
    label: words.busy ? "Sending…" : d?.approve?.label ?? `Approve revision ${queue.revision}`,
    hint: d?.approve?.hint ?? pinsText(queue.revision, stopped),
    submit: () => { if (!disabled) void words.submit(); },
    menu: (!wordsOpen ? [{ label: "Your words with the approval…", onSelect: () => setWordsOpen(true) }] : []) as MenuEntry[],
    wordsBox: wordsOpen && (
      <textarea value={words.text} rows={2} placeholder="Your words with the approval (optional)…" aria-label="Your words with the approval"
        onChange={(e) => words.change(e.target.value)} onKeyDown={words.onKeyDown} className={TEXTAREA} />
    ),
  };
}

/** Ctrl+Enter anywhere but in a text box (whose own Ctrl+Enter sends what is in it). */
export function useCtrlEnter(enabled: boolean, go: () => void) {
  const latest = useRef(go);
  latest.current = go;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("textarea, input, select, [contenteditable=true]"))) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [enabled]);
}

/** "Ask the orchestrator…": the orchestrator's chat, with the queue referenced at the start of its composer. */
export function askOrchestrator(project: string, queue: QueueView) {
  const key = draftKey(project, "orchestrator");
  putDraft(key, withReference(readDraft(key), queueReference(queue.id, queue.revision)));
  nav.open("chat");
}

/** "Ask the orchestrator…" as a button of an action bar; `first` runs before it (the full view becomes its panel). */
export const AskButton = ({ project, queue, first }: { project: string; queue: QueueView; first?: () => void }) => (
  <Button variant="quiet" onClick={() => { first?.(); askOrchestrator(project, queue); }}>Ask the orchestrator…</Button>
);

// ---------------------------------------------------------------- shared parts

/** Who proposed the queue and when, with the orchestrator's message one click away (shown below when open). */
function Proposed({ queue, chat, open, setOpen }: { queue: QueueView; chat: readonly ChatEntry[]; open: boolean; setOpen: (o: boolean) => void }) {
  const draft = draftOf(chat, queue.id);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      {queue.source
        ? <span>imported from <span className="font-mono">{queue.source.path}</span> <TimeAgo at={queue.source.imported_at} /></span>
        : draft ? <span>proposed by the orchestrator <TimeAgo at={draft.at} /></span>
        : queue.updated_at ? <span>proposed <TimeAgo at={queue.updated_at} /></span> : null}
      {draft?.message && (
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="rounded px-1 text-accent hover:bg-surface-3 max-lg:min-h-11">
          {open ? "▾" : "▸"} its message
        </button>
      )}
    </span>
  );
}

function MessageBox({ queue, chat }: { queue: QueueView; chat: readonly ChatEntry[] }) {
  const m = draftOf(chat, queue.id)?.message;
  if (!m) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm">
      <p className="mb-1 text-xs text-fg-3">The orchestrator · <TimeAgo at={m.at} /></p>
      <Markdown>{m.text}</Markdown>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { approval: "text-info bg-info", stopped: "text-stop bg-stop", failed: "text-danger bg-danger" };
function StatusWord({ queue }: { queue: QueueView }) {
  // What the view is for: the approval ("needs approval (revision 3) · then starts after HS" for a revised one); a
  // stopped queue whose revision is approved says where it stopped.
  const honest = queueStatus(queue);
  const s = honest.tone === "approval" || queue.status === "stopped" ? honest : { tone: "approval", label: "needs your approval" };
  const [text, dot] = (STATUS_TONE[s.tone] ?? "text-fg-2 bg-fg-2").split(" ");
  return <span className={`inline-flex items-center gap-1.5 font-medium ${text}`}><span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{s.label}</span>;
}

/** The run settings on one line: "4 steps · on main, after SF · Claude, high · after each step: go on", and SF2's own values. */
export function SettingsLine({ project, queue }: { project: ProjectState; queue: QueueView }) {
  const r = runSettings(queue, project.project);
  return (
    <>
      <span>{r.parts.join(" · ")}</span>
      {r.own.length > 0 && <span className="text-review" title="Steps with their own runtime, model or effort">⚙ {r.own.join("; ")}</span>}
    </>
  );
}

const Acceptance = ({ step }: { step: StepView }) => (
  <>
    {step.acceptance.length > 0 && (
      <>
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-fg-3">Acceptance</p>
        <ul className="space-y-1.5">
          {step.acceptance.map((a, i) => (
            <li key={i} className="grid grid-cols-[16px_1fr] gap-2 text-sm text-fg-2"><span className="text-fg-3">◇</span><Markdown className="[&_p]:m-0">{a}</Markdown></li>
          ))}
        </ul>
      </>
    )}
    {step.review?.prepare && <p className="text-sm text-fg-2"><span className="text-fg-3">Review to prepare: </span>{step.review.prepare}</p>}
  </>
);

function StopConditions({ project, queue }: { project: ProjectState; queue: QueueView }) {
  const inherited = project.project.defaults.stop_conditions;
  return (
    <ul className="space-y-1.5 text-sm text-fg">
      {queue.stop_conditions.map((c, i) => <li key={i} className="flex gap-2"><span className="text-stop/70">■</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}
      {inherited.map((c, i) => <li key={`p${i}`} className="flex gap-2 text-fg-3"><span>□</span><span>{c} <span className="text-xs">(project)</span></span></li>)}
      {queue.stop_conditions.length + inherited.length === 0 && <li className="text-fg-3">None.</li>}
    </ul>
  );
}
const Checks = ({ queue }: { queue: QueueView }) => (
  <ul className="space-y-1 text-sm text-fg">{queue.checks.map((c, i) => <li key={i} className="flex gap-2"><span className="text-ok/80">✓</span><Markdown className="[&_p]:m-0">{c}</Markdown></li>)}</ul>
);
const stopCount = (project: ProjectState, queue: QueueView) => queue.stop_conditions.length + project.project.defaults.stop_conditions.length;

// ---------------------------------------------------------------- the compact list (the drawer, the phone)

/**
 * The queue's steps, what the user approves, one row each: the title and the goal's first lines, "N criteria ▾" to
 * open the whole goal and its acceptance in place; then the description, the stop conditions, the checks and the
 * orchestrator's message as folds. `onFull` adds the switch to the full view.
 */
export function CompactSteps({ project, queue, chat, onFull }: { project: ProjectState; queue: QueueView; chat: readonly ChatEntry[]; onFull?: () => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen({ ...open, [k]: !open[k] });
  const fold = (k: string, label: string) => (
    <button key={k} onClick={() => toggle(k)} aria-expanded={!!open[k]} className="rounded px-1 py-0.5 text-left text-accent hover:bg-surface-3 max-lg:min-h-11">
      {open[k] ? "▾" : "▸"} {label}
    </button>
  );
  const draft = draftOf(chat, queue.id);
  return (
    <section className="mt-5">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-2">Steps · what you approve</h3>
        <span className="flex-1" />
        {onFull && <button onClick={onFull} className="rounded px-1.5 py-0.5 text-xs text-accent hover:bg-surface-3 max-lg:min-h-11" title="The whole queue in one scroll">Full view ⤢</button>}
      </div>
      <ul className="overflow-hidden rounded-lg border border-line">
        {queue.steps.map((s) => {
          const n = s.acceptance.length;
          const o = !!open[s.id];
          return (
            <li key={s.id} className="border-b border-line last:border-b-0">
              <button onClick={() => toggle(s.id)} aria-expanded={o}
                className="grid w-full grid-cols-[3rem_1fr_auto] gap-x-2 px-3 py-2.5 text-left hover:bg-surface-2">
                <span className="pt-px font-mono text-xs leading-5 text-fg-3">{s.id}</span>
                <span className="min-w-0">
                  <span className="block font-semibold text-fg">{s.title}</span>
                  {s.goal && !o && <span className="mt-0.5 line-clamp-2 text-sm text-fg-2">{s.goal.replace(/\s+/g, " ")}</span>}
                </span>
                <span className="whitespace-nowrap pt-0.5 text-xs text-fg-3">{n ? `${n} criteri${n === 1 ? "on" : "a"}` : "no criteria"} {o ? "▴" : "▾"}</span>
              </button>
              {o && (
                <div className="space-y-2 px-3 pb-3 pl-[4.25rem]">
                  {s.goal && <div className="text-sm text-fg-2"><Markdown>{s.goal}</Markdown></div>}
                  <Acceptance step={s} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {queue.description && fold("description", "Description")}
        {fold("stops", `Stop conditions · ${stopCount(project, queue)}`)}
        {queue.checks.length > 0 && fold("checks", `Checks · ${queue.checks.length}`)}
        {draft?.message && fold("message", "The orchestrator's message")}
      </div>
      {open.description && queue.description && <div className="mt-2 text-sm text-fg-2"><Markdown>{queue.description}</Markdown></div>}
      {open.stops && <div className="mt-2"><StopConditions project={project} queue={queue} /></div>}
      {open.checks && <div className="mt-2"><Checks queue={queue} /></div>}
      {open.message && <div className="mt-2"><MessageBox queue={queue} chat={chat} /></div>}
    </section>
  );
}

// ---------------------------------------------------------------- the full view (a desktop)

/**
 * The whole queue in one scroll (mockup 15): where it is and its title, its status, run settings and who proposed it
 * on one line; an outline on the left (description, each step, stop conditions, checks) that follows the scroll and
 * jumps on a click; every step's goal and acceptance in the page; the action bar with what approving pins. On a
 * desktop it leaves the project sidebar in sight (`sidebar`, its width); "Ask the orchestrator…" shows the queue as a
 * panel beside the chat, so the chat and the queue are both in view.
 */
export function ApprovalView({ project, queue, chat, sidebar, onClose, onPanel, onChanged }: {
  project: ProjectState; queue: QueueView; chat: readonly ChatEntry[]; sidebar?: string;
  onClose: () => void; onPanel: () => void; onChanged: () => void;
}) {
  const id = project.project.id;
  const stopped = queue.status === "stopped";
  const leftState = useLeft(id, queue.id, stopped, stopVersion(queue));
  const left = leftState === "error" ? undefined : leftState;
  const [work, setWork] = useState<WorkChoice>();
  const a = useApprove({ project: id, queue, left: leftState, work, onChanged });
  useCtrlEnter(true, a.submit);
  const [messageOpen, setMessageOpen] = useState(false);

  // The outline: its entries, the one in view, a click scrolls to it.
  const doc = useRef<HTMLDivElement>(null);
  const entries: { key: string; mark: ReactNode; label: string }[] = [
    ...(stopped ? [{ key: "stop", mark: <span className="text-stop">■</span>, label: "The stop" }] : []),
    ...(queue.description ? [{ key: "description", mark: "≡", label: "Description" }] : []),
    ...queue.steps.map((s) => ({ key: `step-${s.id}`, mark: <span className="font-mono text-[11px]">{s.id}</span>, label: s.title })),
    { key: "stops", mark: "⚑", label: `Stop conditions · ${stopCount(project, queue)}` },
    ...(queue.checks.length ? [{ key: "checks", mark: "✓", label: `Checks · ${queue.checks.length}` }] : []),
  ];
  const [current, setCurrent] = useState(entries[0]?.key);
  // The part picked in the outline stays marked while it shows (the last ones cannot reach the top), until the user
  // scrolls by hand.
  const picked = useRef<string | undefined>(undefined);
  useEffect(() => {
    const d = doc.current;
    if (!d) return;
    const top = (key: string) => d.querySelector(`[data-part="${key}"]`)?.getBoundingClientRect().top;
    const on = () => {
      const box = d.getBoundingClientRect();
      if (picked.current) {
        const t = top(picked.current);
        if (t !== undefined && t >= box.top - 4 && t < box.bottom - 40) { setCurrent(picked.current); return; }
      }
      let at = entries[0]?.key;
      for (const e of entries) { const t = top(e.key); if (t !== undefined && t <= box.top + 24) at = e.key; }
      setCurrent(at);
    };
    const byHand = () => { picked.current = undefined; };
    d.addEventListener("scroll", on, { passive: true });
    d.addEventListener("wheel", byHand, { passive: true });
    d.addEventListener("touchstart", byHand, { passive: true });
    d.addEventListener("keydown", byHand);
    return () => {
      d.removeEventListener("scroll", on); d.removeEventListener("wheel", byHand);
      d.removeEventListener("touchstart", byHand); d.removeEventListener("keydown", byHand);
    };
  });
  const jump = (key: string) => {
    const d = doc.current;
    const el = d?.querySelector<HTMLElement>(`[data-part="${key}"]`);
    if (!d || !el) return;
    picked.current = key;
    d.scrollTo({ top: el.getBoundingClientRect().top - d.getBoundingClientRect().top + d.scrollTop - 16, behavior: "smooth" });
    setCurrent(key);
  };

  const menu: MenuEntry[] = [...a.menu, { label: "Show as a panel", onSelect: onPanel }];
  const fail = a.words.error;
  const hint = fail ? <span className="text-danger">{fail}</span>
    : a.note ? <span className="text-info">{a.note}</span>
    : <>{a.hint} · Ctrl+Enter</>;
  return (
    <div role="dialog" aria-label={`Approve queue ${queue.id}`} className="fixed inset-y-0 right-0 z-40 flex flex-col bg-canvas pt-[env(safe-area-inset-top)]" style={{ left: sidebar ?? 0 }}>
      <header className="shrink-0 border-b border-line bg-surface px-5 pb-3.5 pt-3 sm:px-7 sm:pt-4">
        <div className="flex items-center gap-2 text-xs text-fg-3">
          <span className="min-w-0 truncate">{project.project.name} · queue · revision {queue.revision}</span>
          <span className="flex-1" />
          <CloseButton onClose={onClose} />
        </div>
        <h1 className="mt-0.5 text-lg font-semibold text-fg sm:text-xl"><span className="mr-2 font-mono text-fg-3">{queue.id}</span>{queue.title}</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-fg-3">
          <StatusWord queue={queue} />
          <SettingsLine project={project} queue={queue} />
          <Proposed queue={queue} chat={chat} open={messageOpen} setOpen={setMessageOpen} />
        </div>
        {messageOpen && <div className="mt-3 max-w-[900px]"><MessageBox queue={queue} chat={chat} /></div>}
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[300px_1fr]">
        <nav aria-label="In this queue" className="scroll-thin hidden overflow-y-auto border-r border-line px-3 py-4 lg:block">
          <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-3">In this queue</p>
          {entries.map((e) => (
            <button key={e.key} onClick={() => jump(e.key)} aria-current={current === e.key ? "location" : undefined}
              className={`grid w-full grid-cols-[38px_1fr] gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[13px] ${current === e.key ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-2"}`}>
              <span className="text-fg-3">{e.mark}</span><span>{e.label}</span>
            </button>
          ))}
        </nav>
        <div ref={doc} className="scroll-thin relative min-h-0 overflow-y-auto px-5 py-4 sm:px-8">
          <div className="max-w-[900px] space-y-5 pb-10">
            {stopped && (
              <div data-part="stop" className="[&>div]:mt-0">
                <StopBox queue={queue} left={left ?? undefined} work={work} setWork={setWork} needsChoice={needsWorkChoice(left)} pushAccepted={project.project.defaults.push_accepted} />
              </div>
            )}
            {queue.description && (
              <section data-part="description" className="border-b border-line pb-4">
                <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-3">Description</h2>
                <div className="text-sm text-fg-2"><Markdown>{queue.description}</Markdown></div>
              </section>
            )}
            {queue.steps.map((s) => (
              <section key={s.id} data-part={`step-${s.id}`} className="space-y-2 border-b border-line pb-4">
                <h2 className="flex items-baseline gap-2.5 font-semibold text-fg"><span className="font-mono text-xs font-normal text-fg-3">{s.id}</span>{s.title}</h2>
                {s.goal ? <div className="text-sm text-fg-2"><Markdown>{s.goal}</Markdown></div> : <p className="text-sm text-fg-3">No goal written.</p>}
                <Acceptance step={s} />
              </section>
            ))}
            <section data-part="stops" className="border-b border-line pb-4">
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-3">Stop conditions</h2>
              <StopConditions project={project} queue={queue} />
            </section>
            {queue.checks.length > 0 && (
              <section data-part="checks">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-3">Checks for every step</h2>
                <Checks queue={queue} />
              </section>
            )}
          </div>
        </div>
      </div>
      <ActionBar hint={hint} menu={menu} secondary={<AskButton project={id} queue={queue} first={onPanel} />}
        primary={<Button disabled={a.disabled} onClick={a.submit}>{a.label}</Button>}>
        {a.wordsBox}
      </ActionBar>
    </div>
  );
}
