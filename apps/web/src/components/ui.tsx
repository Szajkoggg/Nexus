import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

// ---------------------------------------------------------------- status colours

type Tone = { dot: string; text: string; ring: string; bg: string };
// Written out in full so Tailwind sees every class.
const TONES: Record<string, Tone> = {
  pending: { dot: "bg-zinc-500", text: "text-zinc-400", ring: "ring-zinc-700", bg: "bg-zinc-800/40" },
  draft: { dot: "bg-zinc-500", text: "text-zinc-400", ring: "ring-zinc-700", bg: "bg-zinc-800/40" },
  proposed: { dot: "bg-slate-300", text: "text-slate-300", ring: "ring-slate-500/40", bg: "bg-slate-500/10" },
  approved: { dot: "bg-sky-400", text: "text-sky-300", ring: "ring-sky-500/40", bg: "bg-sky-500/10" },
  running: { dot: "bg-blue-400 animate-pulse", text: "text-blue-300", ring: "ring-blue-500/50", bg: "bg-blue-500/10" },
  waiting: { dot: "bg-amber-400", text: "text-amber-300", ring: "ring-amber-500/50", bg: "bg-amber-500/10" },
  review: { dot: "bg-violet-400", text: "text-violet-300", ring: "ring-violet-500/50", bg: "bg-violet-500/10" },
  paused: { dot: "bg-zinc-400", text: "text-zinc-300", ring: "ring-zinc-500/40", bg: "bg-zinc-500/10" },
  stopped: { dot: "bg-orange-400", text: "text-orange-300", ring: "ring-orange-500/50", bg: "bg-orange-500/10" },
  failed: { dot: "bg-red-400", text: "text-red-300", ring: "ring-red-500/50", bg: "bg-red-500/10" },
  done: { dot: "bg-emerald-400", text: "text-emerald-300", ring: "ring-emerald-500/30", bg: "bg-emerald-500/5" },
  skipped: { dot: "bg-zinc-600", text: "text-zinc-500", ring: "ring-zinc-800", bg: "bg-zinc-900" },
  cancelled: { dot: "bg-zinc-600", text: "text-zinc-500", ring: "ring-zinc-800", bg: "bg-zinc-900" },
};
export const toneOf = (status: string): Tone => TONES[status] ?? TONES.pending!;

export function StatusBadge({ status, label, className = "" }: { status: string; label?: string; className?: string }) {
  const t = toneOf(status);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${t.ring} ${t.bg} ${t.text} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {label ?? status}
    </span>
  );
}

// ---------------------------------------------------------------- text

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`md text-sm leading-relaxed text-zinc-300 ${className}`}>
      <ReactMarkdown components={{ a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

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

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
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
        <button onClick={() => setOpen(!open)} className="mt-1 text-xs text-sky-400 hover:text-sky-300">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- writing

/** A text box with a submit button. Ctrl+Enter submits. Keeps the text if the submit fails. */
export function Composer({ placeholder, button, onSubmit, allowEmpty = false, rows = 3, extra }: {
  placeholder: string; button: string; onSubmit: (text: string) => Promise<void>;
  allowEmpty?: boolean; rows?: number; extra?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (busy || (!allowEmpty && !text.trim())) return;
    setBusy(true); setError(undefined);
    try { await onSubmit(text.trim()); setText(""); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div>
      <textarea
        value={text} rows={rows} placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
        className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={busy || (!allowEmpty && !text.trim())}>{busy ? "Sending…" : button}</Button>
        {extra}
        <span className="text-xs text-zinc-600">Ctrl+Enter</span>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = "primary" }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; variant?: "primary" | "quiet" | "danger";
}) {
  const style = {
    primary: "bg-sky-600 text-white hover:bg-sky-500",
    quiet: "bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
    danger: "text-red-300 hover:bg-red-500/10",
  }[variant];
  return (
    <button onClick={onClick} disabled={disabled} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${style}`}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- drawer

export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="scroll-thin relative h-full w-full max-w-2xl overflow-y-auto border-l border-zinc-800 bg-zinc-900 pt-[env(safe-area-inset-top)] shadow-2xl">
        <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <div className="p-5 pt-6 sm:p-6">{children}</div>
      </aside>
    </div>
  );
}
