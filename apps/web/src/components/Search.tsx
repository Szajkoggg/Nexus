// The search of a project's whole history (queue SR): a field in the project's header (Ctrl+K on a desktop) opens a
// panel over the page (full screen on the phone) with the query, a filter by kind, and the hits newest first; a hit
// goes to its place: a step's or queue's details, a chat message (CH4's jump, chatTarget.ts), a report in the file
// viewer. The server searches the files (GET /api/projects/:id/search, apps/server/src/search.ts).
import { useEffect, useState } from "react";
import { SEARCH_KINDS, SEARCH_LIMIT, SEARCH_MAX_LIMIT, type SearchHit, type SearchKind, type SearchResult } from "@nexus/protocol/search";
import { enc, projectUrl, request, useQuery } from "../api.ts";
import { usePage } from "../page.ts";
import { nav } from "../nav.ts";
import { fileLayer } from "../fileview.ts";
import { placeKey } from "../chatPlace.ts";
import { setChatTarget } from "../chatTarget.ts";
import { t, type Key } from "../i18n.ts";
import { Marked } from "./ChatTools.tsx";
import { CloseButton, TimeAgo } from "./ui.tsx";

/** How many hits a search asks for at first (the server's default); each "Show more" asks for twice as many more, up to the server's most. */
const PAGE = SEARCH_LIMIT;
const MOST = SEARCH_MAX_LIMIT;

const KIND_LABEL: Record<SearchKind, Key> = {
  queue: "search.kind.queue", step: "search.kind.step", question: "search.kind.question", chat: "search.kind.chat",
  report: "search.kind.report", review: "search.kind.review", note: "search.kind.note",
};

/** What the panel had when it closed: it opens again with the same query and filter. */
const last: { query: string; kind: SearchKind | "all"; tools: boolean } = { query: "", kind: "all", tools: false };

/** The search's URL, or undefined while there is nothing to search. */
function searchUrl(project: string, o: { query: string; kind: SearchKind | "all"; tools: boolean; limit: number }): string | undefined {
  if (!o.query.trim()) return undefined;
  return projectUrl(project, `/search?q=${enc(o.query.trim())}${o.kind === "all" ? "" : `&kinds=${o.kind}`}${o.tools ? "&tools=1" : ""}&limit=${o.limit}`);
}

const SearchIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
);

/** Opens the search (a layer: Back closes it), or focuses its field when it is open. */
function openSearch(): void {
  const field = document.querySelector<HTMLInputElement>("[data-history-search] input");
  if (field) field.focus();
  else nav.open("search");
}

/** Ctrl+K (⌘K on a Mac) opens the search from anywhere on the project's page. */
export function useSearchShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** The field in a desktop's project header: it looks like the search's field and opens it. */
export function SearchField() {
  return (
    <button type="button" onClick={openSearch} title={t("search.openTitle")}
      className="flex w-56 shrink items-center gap-2 rounded-lg border border-line-strong bg-canvas px-2.5 py-1.5 text-left text-[13px] text-fg-3 hover:border-fg-3/60 hover:text-fg-2">
      <SearchIcon size={14} />
      <span className="min-w-0 flex-1 truncate">{t("search.field")}</span>
      <kbd className="rounded border border-line px-1 font-sans text-[11px] text-fg-3">Ctrl K</kbd>
    </button>
  );
}

/** The phone header's button that opens the search. */
export function SearchIconButton() {
  return (
    <button type="button" onClick={openSearch} title={t("search.openTitle")} aria-label={t("search.open")}
      className="grid h-9 w-9 place-items-center rounded-lg text-fg-2 active:bg-surface-3">
      <SearchIcon size={18} />
    </button>
  );
}

/** Where a hit is, in a few words: the queue and step, or the chat. */
function placeOf(h: SearchHit): string {
  if (h.kind === "chat") return h.title ?? t("search.chatUntitled");
  if (h.queue) return h.step ? `${h.queue} / ${h.step}` : h.queue;
  return t("search.noPlace");
}

/** The panel: the field, the kinds, the hits. */
export function SearchPanel({ project, onClose }: { project: string; onClose: () => void }) {
  const { version } = usePage();
  const [query, setQuery] = useState(last.query);
  const [kind, setKind] = useState(last.kind);
  const [tools, setTools] = useState(last.tools);
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<{ url: string; data?: SearchResult; error?: string }>();
  const conversations = useQuery<{ id: string }[]>(projectUrl(project, "/conversations"), version).data;
  useEffect(() => { Object.assign(last, { query, kind, tools }); }, [query, kind, tools]);
  useEffect(() => setLimit(PAGE), [query, kind, tools]);
  const url = searchUrl(project, { query, kind, tools, limit });
  // The server searches a moment after the typing stops; a newer query aborts the older one's request.
  useEffect(() => {
    if (!url) { setResult(undefined); return; }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      request<SearchResult>(url, { signal: ctl.signal })
        .then((data) => setResult({ url, data }), (e: Error) => { if (e.name !== "AbortError") setResult({ url, error: e.message }); });
    }, 250);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [url]);
  // What is shown: the latest answer, kept while a longer list ("Show more") or the next query loads.
  const data = result?.data;
  const searching = !!url && result?.url !== url;

  /** What a click on a hit does, or undefined when it has no place to go (a question not about a step). */
  const destination = (h: SearchHit): (() => void) | undefined => {
    const { session, line, path, queue } = h;
    if (h.kind === "chat") {
      if (session === undefined || line === undefined) return undefined;
      return () => {
        const conversation = conversations?.some((c) => c.id === session);
        const place = conversation ? placeKey(project, "conversation", session) : placeKey(project, "orchestrator");
        setChatTarget({ place, session, line, tool: h.tool });
        if (conversation) nav.closeThenConversation("search", session);
        else nav.closeThenTab("search", "chat");
      };
    }
    if (h.kind === "report") return path ? () => nav.closeThenOpen("search", fileLayer(path)) : undefined;
    return queue ? () => nav.closeThenItem("search", project, queue, h.step) : undefined;
  };

  const chip = (k: SearchKind | "all", label: string) => (
    <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs max-lg:min-h-9 max-lg:px-3 ${kind === k ? "border-accent bg-accent/15 font-semibold text-fg" : "border-line-strong text-fg-2 hover:text-fg"}`}>{label}</button>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-history-search role="search">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-fg-3"><SearchIcon size={18} /></span>
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.open")}
          onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }}
          className="min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-fg-3 focus:outline-none" />
        <CloseButton onClose={onClose} />
      </div>
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-4 py-2" role="group" aria-label={t("search.kinds")}>
        {chip("all", t("search.kind.all"))}
        {SEARCH_KINDS.map((k) => chip(k, t(KIND_LABEL[k])))}
        <span className="flex-1" />
        <label className="flex shrink-0 items-center gap-1.5 pl-2 text-xs text-fg-2" title={t("search.toolsTitle")}>
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} className="accent-accent" />{t("search.tools")}
        </label>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {!url && (
          <div className="px-6 py-10 text-center text-sm text-fg-2">
            <p>{t("search.emptyTitle")}</p>
            <p className="mt-1.5 text-fg-3">{t("search.emptyNote")}</p>
          </div>
        )}
        {url && (
          <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-xs text-fg-3" aria-live="polite">
            {result?.error ? <span className="text-danger">{result.error}</span>
              : data ? <span>{data.more ? t("search.countMore", { shown: data.hits.length, count: data.total }) : t("search.count", { count: data.total })}</span>
              : null}
            {searching && <span className="animate-pulse">{t("search.searching")}</span>}
          </div>
        )}
        {url && data && data.hits.length === 0 && !searching && <p className="px-4 py-6 text-center text-sm text-fg-3">{t("search.none")}</p>}
        {url && data && data.hits.length > 0 && (
          <ul className="space-y-0.5 px-2 pb-3">
            {data.hits.map((h, i) => {
              const go = destination(h);
              return <li key={`${h.kind}:${h.session ?? ""}:${h.line ?? ""}:${h.queue ?? ""}:${h.step ?? ""}:${h.at}:${i}`}>
                <button type="button" onClick={go} disabled={!go}
                  className="w-full rounded-lg px-3 py-2 text-left hover:bg-surface-3/70 disabled:cursor-default disabled:hover:bg-transparent">
                  <span className="flex items-baseline gap-2 text-xs">
                    <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-semibold text-fg-2">{t(KIND_LABEL[h.kind])}</span>
                    <span className={`min-w-0 truncate ${h.kind === "chat" ? "text-fg-2" : "font-mono text-accent"}`}>{placeOf(h)}</span>
                    {h.kind !== "chat" && h.title && <span className="min-w-0 truncate text-fg-3">{h.title}</span>}
                    <span className="ml-auto shrink-0 text-fg-3"><TimeAgo at={h.at} /></span>
                  </span>
                  <span className="mt-1 line-clamp-2 block text-sm text-fg"><Marked text={h.excerpt} ranges={h.ranges} /></span>
                </button>
              </li>;
            })}
          </ul>
        )}
        {data?.more && limit < MOST && (
          <div className="px-4 pb-4"><button type="button" onClick={() => setLimit(Math.min(MOST, limit + PAGE * 2))} className="text-sm text-accent hover:underline">{t("search.more")}</button></div>
        )}
      </div>
    </div>
  );
}
