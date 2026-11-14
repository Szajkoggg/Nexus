// The morning digest (UX proposals, 16; mockup 16): since the user last looked on this device, across projects: four
// numbers, what happened newest first, "Go through them one by one" for what waits, and at its foot the usage line. It shows when something is
// new since the stored time; "Mark as seen" stores now and folds it. On a desktop at the top of the right rail, on the
// phone at the top of the Waiting tab; the waiting list itself is the one below it there.
import { useState } from "react";
import type { DigestEvent, DigestResponse } from "@nexus/protocol/digest";
import { mergeAttention } from "@nexus/protocol/attention";
import { fileUrl, useFetch, type ProjectSummary } from "../api.ts";
import { digestTiles, hasNews, outcome, usageLine, type Tone } from "../digest.ts";
import { nav } from "../nav.ts";
import { formatClock, t } from "../i18n.ts";
import { Clock } from "./ui.tsx";

const KEY = "nexus.digest.seen";
/** When the user last marked the digest as seen on this device; the first time, a day ago. */
const storedSeen = (): string => {
  try { const v = localStorage.getItem(KEY); if (v && !Number.isNaN(Date.parse(v))) return v; } catch { /* not kept */ }
  return new Date(Date.now() - 86_400_000).toISOString();
};

const TONE: Record<Tone, string> = { ok: "text-ok", stop: "text-stop", danger: "text-danger", warn: "text-warn", muted: "text-fg-3" };
const DOT: Record<Tone, string> = { ok: "bg-ok", stop: "bg-stop", danger: "bg-danger", warn: "bg-warn", muted: "bg-fg-3" };
const SHOWN = 6;

const greeting = (d = new Date()) => t(d.getHours() < 12 ? "digest.morning" : d.getHours() < 18 ? "digest.afternoon" : "digest.evening");

export function Digest({ projects, version, onGoThrough }: { projects: ProjectSummary[]; version: unknown; onGoThrough: () => void }) {
  const [seen, setSeen] = useState(storedSeen);
  const [all, setAll] = useState(false);
  const d = useFetch<DigestResponse>(`/api/digest?since=${encodeURIComponent(seen)}`, version);
  const waiting = mergeAttention(projects);
  if (!d || !hasNews(d.events, waiting, seen)) return null;
  const tiles = digestTiles(d.events, waiting, d.running);
  const markSeen = () => {
    const now = new Date().toISOString();
    try { localStorage.setItem(KEY, now); } catch { /* not kept */ }
    setSeen(now);
  };
  const rows = all ? d.events : d.events.slice(0, SHOWN);
  const tile = (t: { n: number; text: string }, color: string) => (
    <div className="rounded-lg border border-line bg-surface px-2.5 py-2">
      <div className={`text-xl font-semibold leading-tight ${t.n ? color : "text-fg-3"}`}>{t.n}</div>
      <div className="line-clamp-2 text-xs leading-snug text-fg-2">{t.text}</div>
    </div>
  );
  return (
    <section aria-label={t("digest.label")} className="rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-semibold text-fg">{greeting()}</h2>
        <span className="flex-1" />
        <button onClick={markSeen} className="rounded-md px-2 py-1 text-xs font-medium text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:min-h-11">{t("digest.markSeen")}</button>
      </div>
      <p className="text-xs text-fg-3">{t("digest.since", { time: formatClock(seen, new Date()) })}</p>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {tile(tiles.finished, "text-ok")}
        {tile(tiles.stopped, "text-stop")}
        {tile(tiles.waiting, "text-warn")}
        {tile(tiles.running, "text-accent")}
      </div>

      {d.events.length > 0 && <>
        <h3 className="mb-1 mt-3.5 text-[11px] font-semibold uppercase tracking-wider text-fg-3">{t("digest.happened")}</h3>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map((e, i) => <Line key={`${e.project}/${e.kind}/${e.queue}/${e.step}/${e.at}/${i}`} e={e} />)}
        </ul>
        {d.events.length > SHOWN && (
          <button onClick={() => setAll(!all)} className="mt-1 text-xs text-fg-3 hover:text-fg max-lg:min-h-11">
            {all ? t("digest.fewer") : t("digest.more", { count: d.events.length - SHOWN })}
          </button>
        )}
      </>}

      {waiting.length > 0 && <>
        <button onClick={onGoThrough} className="mt-3 w-full rounded-lg bg-accent-strong px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent max-lg:min-h-11">
          {t("digest.goThrough")}
        </button>
        <p className="mt-1 text-xs text-fg-3">{t("digest.goThroughNote", { count: waiting.length })}</p>
      </>}

      {d.usage && <p className="mt-3 border-t border-line pt-2 text-xs text-fg-2">{usageLine(d.usage)}</p>}
    </section>
  );
}

/** One line of what happened: when, which queue or step, its outcome and words, its project; a tap opens the item. */
function Line({ e }: { e: DigestEvent }) {
  const o = outcome(e);
  const open = () => { if (e.queue) nav.item(e.project, e.queue, e.kind === "stopped" || e.kind === "queue_done" || e.kind === "queue_cancelled" ? undefined : e.step); };
  return (
    <li>
      <button onClick={open} className="block w-full px-2.5 py-2 text-left hover:bg-surface-3/50">
        <span className="flex items-center gap-2 text-xs text-fg-3">
          <span className="w-10 shrink-0"><Clock at={e.at} /></span>
          <span className="min-w-0 truncate font-mono">{e.step ?? e.queue}</span>
          <span className="flex-1" />
          <span className="shrink-0 truncate">{e.project_name}</span>
        </span>
        <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug">
          <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${DOT[o.tone]}`} />
          <span className={TONE[o.tone]}>{o.word}</span> <span className="text-fg-2">{e.text}</span>
        </span>
      </button>
      {e.report && (
        <a href={fileUrl(e.project, e.report)} target="_blank" rel="noreferrer" className="-mt-1 block px-2.5 pb-2 pl-[3.25rem] text-xs text-accent hover:underline">{t("digest.report")}</a>
      )}
    </li>
  );
}
