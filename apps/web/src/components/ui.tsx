import { useEffect, useRef, useState, type ReactNode } from "react";
import { readDraft, writeDraft } from "../drafts.ts";
import ReactMarkdown from "react-markdown";
import { formatClock, formatDuration, runTimes, stepTimes } from "@nexus/protocol/times";
import type { QueueView, StepView } from "../api.ts";

// ---------------------------------------------------------------- status colours

type Tone = { dot: string; text: string };
// A status is a dot and a word in the status's colour, never a ring or a filled pill (docs/DESIGN.md, theme tokens).
// Written out in full so Tailwind sees every class.
const TONES: Record<string, Tone> = {
  pending: { dot: "bg-fg-3", text: "text-fg-3" },
  draft: { dot: "bg-fg-3", text: "text-fg-3" },
  proposed: { dot: "bg-fg-2", text: "text-fg-2" },
  approved: { dot: "bg-info", text: "text-info" },
  running: { dot: "bg-accent animate-pulse", text: "text-accent" },
  waiting: { dot: "bg-warn", text: "text-warn" },
  review: { dot: "bg-review", text: "text-review" },
  paused: { dot: "bg-fg-2", text: "text-fg-2" },
  stopped: { dot: "bg-stop", text: "text-stop" },
  failed: { dot: "bg-danger", text: "text-danger" },
  rejected: { dot: "bg-danger", text: "text-danger" },
  done: { dot: "bg-ok", text: "text-ok" },
  skipped: { dot: "bg-fg-3", text: "text-fg-3" },
  cancelled: { dot: "bg-fg-3", text: "text-fg-3" },
};
export const toneOf = (status: string): Tone => TONES[status] ?? TONES.pending!;

/** A step in review says whom it waits for. */
export function reviewLabel(step: { status: string; review_with?: "orchestrator" | "user" }): string | undefined {
  if (step.status !== "review") return undefined;
  return step.review_with === "orchestrator" ? "review: orchestrator" : "review: you";
}

export function StatusBadge({ status, label, className = "" }: { status: string; label?: string; className?: string }) {
  const t = toneOf(status);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${t.text} ${className}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} />
      {label ?? status}
    </span>
  );
}

// ---------------------------------------------------------------- text

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`md text-sm leading-relaxed text-fg ${className}`}>
      <ReactMarkdown components={{ a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A window wide enough for a step's details on the left and a chat on the right at once (1280 px: below it, two
 * readable panels, about 510 and 430 px, would leave the queue list no room at all).
 */
export const WIDE = "(min-width: 1280px)";
export function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof matchMedia !== "undefined" && matchMedia(WIDE).matches);
  useEffect(() => {
    const m = matchMedia(WIDE);
    const f = () => setWide(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return wide;
}

/** Widths of the side panels on a wide screen; the queue list keeps what lies between them. */
export const SIDE_LEFT = "min(36rem, 40vw)";
export const SIDE_RIGHT = "min(30rem, 34vw)";

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

export function TimeAgo({ at }: { at?: string }) {
  const now = useNow();
  if (!at) return null;
  const d = (now - Date.parse(at)) / 1000;
  const text = d < 60 ? "just now" : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : `${Math.floor(d / 86400)} d ago`;
  return <time dateTime={at} title={new Date(at).toLocaleString()} className="whitespace-nowrap">{text}</time>;
}

/** An absolute local time: "14:02" today, with the date on another day. The full date and time on hover. */
export function Clock({ at }: { at: string }) {
  const now = useNow();
  return <time dateTime={at} title={new Date(at).toLocaleString()} className="whitespace-nowrap">{formatClock(at, new Date(now))}</time>;
}

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

const STEP_END: Record<string, string> = { done: "finished", review: "finished", rejected: "finished", failed: "failed", stopped: "stopped" };

/** When a step started and ended and how long it took; while it is at work, the elapsed time, updating live. */
export function StepTimes({ step, compact }: { step: StepView; compact?: boolean }) {
  const now = useNow(15_000);
  const t = stepTimes(step.segments, now);
  if (!t.started) return null;
  const took = formatDuration(t.duration_ms!);
  if (compact) {
    return (
      <span title={`started ${new Date(t.started).toLocaleString()}${t.ended ? `, ended ${new Date(t.ended).toLocaleString()}` : ""}`} className="whitespace-nowrap">
        {t.running ? "since " : ""}<Clock at={t.started} />{t.ended && sameDay(t.started, t.ended) && <>–{formatClock(t.ended, new Date(t.ended))}</>} · {took}
      </span>
    );
  }
  return (
    <>
      <span>started <Clock at={t.started} /></span>
      {t.ended && <span>{STEP_END[step.status] ?? "ended"} <Clock at={t.ended} /></span>}
      <span>{t.running ? `${took} so far` : `took ${took}`}</span>
      {t.segments > 1 && <span title="The sum of the stretches it was at work">working {formatDuration(t.working_ms!)}, started {t.segments} times</span>}
    </>
  );
}

const RUN_END: Record<string, string> = { finished: "finished", halted: "halted", paused: "paused" };

/** When the queue's run started and ended (finished, halted or stopped), and its total time. */
export function RunTimes({ run }: { run: NonNullable<QueueView["run"]> }) {
  const now = useNow(15_000);
  const t = runTimes(run, now);
  const end = run.state === "paused" && run.reason === "stopped by the user" ? "stopped" : RUN_END[run.state] ?? "ended";
  return (
    <>
      <span>started <Clock at={t.started} /></span>
      {t.ended && <span>{end} <Clock at={t.ended} /></span>}
      <span>{t.running ? `${formatDuration(t.total_ms)} so far` : `${formatDuration(t.total_ms)} in total`}</span>
    </>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-3">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Expandable({ text, lines = 3 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 110;
  return (
    <div>
      <div className={!open && long ? "line-clamp-3" : ""}><Markdown>{text}</Markdown></div>
      {long && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-xs text-accent hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- writing

/**
 * A text box with a submit button. Ctrl+Enter submits. What is typed is kept as a draft under `draft` (see drafts.ts)
 * until it is sent: it survives closing the panel, a reload, and is never shown for another target. A failed submit
 * keeps it.
 */
export function Composer(props: ComposerProps) {
  // Keyed by the draft so that moving to another step or conversation starts from that target's own text.
  return <ComposerBox key={props.draft} {...props} />;
}

interface ComposerProps {
  draft: string; placeholder: string; button: string; onSubmit: (text: string) => Promise<void>;
  allowEmpty?: boolean; rows?: number; extra?: ReactNode;
  /** Hands the text over as typed (not trimmed): words recorded verbatim. */
  verbatim?: boolean;
}

function ComposerBox({ draft, placeholder, button, onSubmit, allowEmpty = false, rows = 3, extra, verbatim = false }: ComposerProps) {
  const [text, setText] = useState(() => readDraft(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = useRef(text);
  const change = (value: string) => { current.current = value; setText(value); writeDraft(draft, value); };
  const submit = async () => {
    if (busy || (!allowEmpty && !text.trim())) return;
    const sent = text;
    setBusy(true); setError(undefined);
    try {
      await onSubmit(verbatim ? sent : sent.trim());
      // Whatever was typed while it was sending stays.
      if (current.current === sent) change("");
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div>
      <textarea
        value={text} rows={rows} placeholder={placeholder}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
        className="w-full resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={busy || (!allowEmpty && !text.trim())}>{busy ? "Sending…" : button}</Button>
        {extra}
        <span className="text-xs text-fg-3">Ctrl+Enter</span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = "primary" }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; variant?: "primary" | "quiet" | "danger";
}) {
  const style = {
    primary: "bg-accent-strong text-on-accent hover:bg-accent",
    quiet: "bg-surface-3 text-fg hover:bg-surface-4",
    danger: "text-danger hover:bg-danger/10",
  }[variant];
  return (
    <button onClick={onClick} disabled={disabled} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${style}`}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- drawer

/**
 * A panel from the right. Escape and Back close it through nav.ts, which knows which layer is on top. With `left`, a
 * panel beside the page instead (a step's details on a wide screen): below the header, no backdrop, the page usable.
 */
export function Drawer({ open, onClose, left, children }: { open: boolean; onClose: () => void; left?: boolean; children: ReactNode }) {
  if (!open) return null;
  if (left) {
    return (
      <aside className="scroll-thin fixed bottom-0 left-0 z-20 overflow-y-auto border-r border-line bg-surface shadow-xl"
        style={{ top: "var(--header-h, 0px)", width: SIDE_LEFT }}>
        <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 rounded-md p-1.5 text-fg-2 hover:bg-surface-3 hover:text-fg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <div className="p-5 pt-6">{children}</div>
      </aside>
    );
  }
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <aside className="scroll-thin relative h-full w-full max-w-2xl overflow-y-auto border-l border-line bg-surface pt-[env(safe-area-inset-top)] shadow-2xl">
        <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 rounded-md p-1.5 text-fg-2 hover:bg-surface-3 hover:text-fg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <div className="p-5 pt-6 sm:p-6">{children}</div>
      </aside>
    </div>
  );
}
