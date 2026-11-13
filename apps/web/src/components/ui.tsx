import { useEffect, useRef, useState, type ReactNode } from "react";
import { readDraft, writeDraft } from "../drafts.ts";
import { usePhone } from "../phone.ts";
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
 * The text of a box that submits: kept as a draft under `draft` (see drafts.ts) until it is sent, so it survives
 * closing the panel and a reload and is never shown for another target. A failed submit keeps it, and so does
 * whatever was typed while it was sending. Ctrl+Enter in the box submits (`onKeyDown`). Shared by Composer and the
 * action bars, whose box and button are apart. The caller keys its component by the draft.
 */
export function useDraftText({ draft, onSubmit, allowEmpty = false, verbatim = false }: {
  draft: string; onSubmit: (text: string) => Promise<void>; allowEmpty?: boolean; verbatim?: boolean;
}) {
  const [text, setText] = useState(() => readDraft(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = useRef(text);
  const change = (value: string) => { current.current = value; setText(value); writeDraft(draft, value); };
  const ready = !busy && (allowEmpty || !!text.trim());
  const submit = async () => {
    if (!ready) return;
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
  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } };
  return { text, change, submit, ready, busy, error, setError, onKeyDown };
}

export const TEXTAREA = "w-full resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none";

/** A text box with a submit button below it; see useDraftText. */
export function Composer(props: ComposerProps) {
  // Keyed by the draft so that moving to another step or conversation starts from that target's own text.
  return <ComposerBox key={props.draft} {...props} />;
}

interface ComposerProps {
  draft: string; placeholder: string; button: string; onSubmit: (text: string) => Promise<void>;
  allowEmpty?: boolean; rows?: number; extra?: ReactNode;
  /** Hands the text over as typed (not trimmed): words recorded verbatim. */
  verbatim?: boolean;
  /** One line that grows with the text (up to six), and a round Send beside it: the phone's chat. */
  oneLine?: boolean;
}

function ComposerBox({ draft, placeholder, button, onSubmit, allowEmpty = false, rows = 3, extra, verbatim = false, oneLine = false }: ComposerProps) {
  const t = useDraftText({ draft, onSubmit, allowEmpty, verbatim });
  const box = useRef<HTMLTextAreaElement>(null);
  // The one-line box grows with what is typed, up to six lines, then scrolls.
  useEffect(() => {
    const b = box.current;
    if (!oneLine || !b) return;
    b.style.height = "auto";
    b.style.height = `${Math.min(b.scrollHeight, 6 * 22 + 22)}px`;
  }, [oneLine, t.text]);
  if (oneLine) {
    return (
      <div>
        <div className="flex items-end gap-2">
          <textarea ref={box} value={t.text} rows={1} placeholder={placeholder} aria-label={placeholder}
            onChange={(e) => t.change(e.target.value)} onKeyDown={t.onKeyDown}
            className="min-h-11 flex-1 resize-none rounded-[22px] border border-line-strong bg-canvas px-4 py-2.5 text-sm leading-[22px] text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none" />
          <button onClick={t.submit} disabled={!t.ready} aria-label={button} title={`${button} (Ctrl+Enter)`}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent-strong text-on-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6l-.1 6.5L15 12 3.3 13.9z" /></svg>
          </button>
        </div>
        {t.error && <p className="mt-1 text-xs text-danger">{t.error}</p>}
      </div>
    );
  }
  return (
    <div>
      <textarea value={t.text} rows={rows} placeholder={placeholder} onChange={(e) => t.change(e.target.value)} onKeyDown={t.onKeyDown} className={TEXTAREA} />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button onClick={t.submit} disabled={!t.ready}>{t.busy ? "Sending…" : button}</Button>
        {extra}
        <span className="text-xs text-fg-3">Ctrl+Enter</span>
        {t.error && <span className="text-xs text-danger">{t.error}</span>}
      </div>
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = "primary", pressed }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; variant?: "primary" | "quiet" | "danger";
  /** A toggle (the bar's "Fix it…" while its form is open). */
  pressed?: boolean;
}) {
  const style = {
    primary: "bg-accent-strong text-on-accent hover:bg-accent",
    quiet: `${pressed ? "bg-surface-4" : "bg-surface-3"} text-fg hover:bg-surface-4`,
    danger: "text-danger hover:bg-danger/10",
  }[variant];
  return (
    <button onClick={onClick} disabled={disabled} aria-pressed={pressed} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 max-lg:min-h-11 max-lg:px-4 ${style}`}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- the action bar

/** One entry of a ⋯ menu: an action, or a heading over the entries after it. */
export type MenuEntry =
  | { label: ReactNode; onSelect: () => void; danger?: boolean; checked?: boolean }
  | { heading: string };

/**
 * ⋯: what a panel can do besides its main actions (Reject, Withdraw, settings…). Opens upward from an action bar,
 * downward from a header. Escape or a click outside closes only the menu.
 */
export function Menu({ items, down = false, label = "More actions" }: { items: MenuEntry[]; down?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    // In the capture phase, marked handled and stopped, so nav.ts's Escape does not also close the panel.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        className="grid h-8 w-8 place-items-center rounded-md border border-line-strong bg-surface-2 text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:h-11 max-lg:w-11">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
          <div role="menu" className={`scroll-thin absolute right-0 z-[71] max-h-[60vh] w-max min-w-52 max-w-[min(20rem,85vw)] overflow-y-auto rounded-lg border border-line-strong bg-surface-2 py-1 shadow-xl ${down ? "top-full mt-1.5" : "bottom-full mb-1.5"}`}>
            {items.map((m, i) => "heading" in m
              ? <div key={i} className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-fg-3">{m.heading}</div>
              : (
                <button key={i} role={m.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={m.checked}
                  onClick={() => { setOpen(false); m.onSelect(); }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-3 max-lg:min-h-11 ${m.danger ? "text-danger" : "text-fg"}`}>
                  {m.checked !== undefined && <span className={`w-3 shrink-0 ${m.checked ? "text-accent" : "invisible"}`}>✓</span>}
                  <span className="min-w-0">{m.label}</span>
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The one action bar at the bottom of a panel, always in sight: the main action on the right, the second left of it,
 * everything else under ⋯, a short hint on the left. `children` is the open form of an action (a note, Fix it, a
 * reason), shown above the buttons it belongs to.
 */
export function ActionBar({ left, hint, menu, secondary, primary, children }: {
  /** Controls at the bar's start (the viewer's: the picture's mark and comment), before the hint. */
  left?: ReactNode;
  hint?: ReactNode; menu?: MenuEntry[]; secondary?: ReactNode; primary?: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
      {children && <div className="scroll-thin max-h-[45vh] overflow-y-auto border-b border-line px-4 py-3 sm:px-5">{children}</div>}
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3 sm:px-5">
        {left}
        {hint ? <span className="min-w-[8rem] flex-1 text-xs text-fg-3">{hint}</span> : <span className="mr-auto" />}
        {menu && <Menu items={menu} />}
        {secondary}
        {primary}
      </div>
    </div>
  );
}

export function CloseButton({ onClose, className = "" }: { onClose: () => void; className?: string }) {
  return (
    <button onClick={onClose} aria-label="Close" className={`grid shrink-0 place-items-center rounded-md p-1.5 text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:h-11 max-lg:w-11 ${className}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  );
}

/**
 * A panel's header: where it is, what it is, its status, and ✕ always at the top right. On the phone, where panels
 * are full-screen sheets, its top row is ‹ (back to what was under the sheet), where it is, its place among what waits
 * ("1 of 6") and ✕; `bare` leaves the title and status to the body (a question sheet puts the question first).
 */
export function PanelHeader({ where, title, status, onClose, of, bare }: {
  where: ReactNode; title: ReactNode; status?: ReactNode; onClose: () => void;
  /** Where it stands among what waits ("2 of 6"). */
  of?: string;
  bare?: boolean;
}) {
  const phone = usePhone();
  if (phone) {
    return (
      <header className="shrink-0 border-b border-line">
        <div className="flex min-h-13 items-center gap-1 px-1">
          <button onClick={onClose} aria-label="Back" className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <div className="min-w-0 flex-1 truncate text-sm text-fg-2">{where}</div>
          {of && <span className="shrink-0 whitespace-nowrap px-1 text-sm text-fg-3">{of}</span>}
          <CloseButton onClose={onClose} />
        </div>
        {!bare && (
          <div className="px-4 pb-3">
            <h2 className="text-lg font-semibold leading-snug text-fg">{title}</h2>
            {status && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">{status}</div>}
          </div>
        )}
      </header>
    );
  }
  return (
    <header className="shrink-0 border-b border-line px-5 pb-3 pt-3 sm:px-6">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 pt-1.5 text-xs text-fg-3">{where}{of && <span className="ml-2 whitespace-nowrap text-fg-2">· {of}</span>}</div>
        <CloseButton onClose={onClose} className="-mr-2" />
      </div>
      <h2 className="mt-0.5 text-xl font-semibold text-fg">{title}</h2>
      {status && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">{status}</div>}
    </header>
  );
}

/** What a panel shows between its header and its action bar; it scrolls, they stay. */
export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4 sm:px-6 max-lg:px-4">{children}</div>;
}

// ---------------------------------------------------------------- drawer

/**
 * A panel from the right. Escape and Back close it through nav.ts, which knows which layer is on top. With `left`, a
 * panel beside the page instead (a step's details on a wide screen): below the header, no backdrop, the page usable.
 * With `panel`, the content brings its own PanelHeader (with ✕), PanelBody and ActionBar; else the drawer scrolls
 * and has ✕ itself.
 */
export function Drawer({ open, onClose, left, panel, children }: { open: boolean; onClose: () => void; left?: boolean; panel?: boolean; children: ReactNode }) {
  if (!open) return null;
  const content = panel ? children : <><CloseButton onClose={onClose} className="absolute right-3 top-3" /><div className="p-5 pt-6 sm:p-6 max-lg:px-4 max-lg:pt-14">{children}</div></>;
  if (left) {
    return (
      <aside className={`fixed bottom-0 left-0 z-20 border-r border-line bg-surface shadow-xl ${panel ? "flex flex-col" : "scroll-thin overflow-y-auto"}`}
        style={{ top: "var(--header-h, 0px)", width: SIDE_LEFT }}>
        {content}
      </aside>
    );
  }
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <aside className={`relative h-full w-full max-w-2xl border-l border-line bg-surface pt-[env(safe-area-inset-top)] shadow-2xl max-lg:max-w-none max-lg:border-l-0 ${panel ? "flex flex-col" : "scroll-thin overflow-y-auto"}`}>
        {content}
      </aside>
    </div>
  );
}
