// The dashboard's read-only file viewer (docs/ideas/chat-improvements.md, "How a referenced file opens"): a file of the
// project opened at a line, over everything else; a layer in the history ("file:<line>:<path>", nav.file), so Back and
// Escape close it. Code is highlighted (highlight.ts, loaded on first use) and scrolled to the line; Markdown is
// rendered, with its raw HTML shown as text and pictures from the web not loaded; pictures open in the picture viewer.
// It works on the phone and starts no program. The file is data: it is fetched as text and rendered by React, never
// injected as HTML; the server sandboxes every file it serves (PROTOCOL.md, "Files and commits").
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileUrl } from "../api.ts";
import { baseName, folderOf, isMarkdown, languageOf, plainLines, relativeTarget, withoutFinalNewline, type Token } from "../fileview.ts";
import { formatNumber, t } from "../i18n.ts";
import { nav } from "../nav.ts";
import { ImageViewer } from "./Viewer.tsx";

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; status: number; reason: string }
  | { kind: "picture" }
  | { kind: "pdf" | "binary"; size: number }
  | { kind: "text"; text: string; size: number; cut: boolean };

/** Highlighting a very long text would hold the page; past this it is shown plain. */
const HIGHLIGHT_LIMIT = 512 * 1024;

export function sizeText(bytes: number): string {
  if (bytes < 1024) return t("file.bytes", { size: formatNumber(bytes) });
  if (bytes < 1024 * 1024) return t("file.kb", { size: formatNumber(Math.round(bytes / 102.4) / 10) });
  return t("file.mb", { size: formatNumber(Math.round(bytes / (1024 * 102.4)) / 10) });
}

function useFile(url: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    let alive = true;
    setLoaded({ kind: "loading" });
    const ctl = new AbortController();
    (async () => {
      const r = await fetch(url, { signal: ctl.signal });
      const size = Number(r.headers.get("x-nexus-size") ?? 0);
      const kind = r.headers.get("x-nexus-kind");
      let next: Loaded;
      if (!r.ok) next = { kind: "error", status: r.status, reason: ((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText };
      else if (kind === "text") next = { kind: "text", text: await r.text(), size, cut: r.headers.get("x-nexus-truncated") === "1" };
      else {
        ctl.abort(); // a picture loads in the picture viewer; a binary is not read here
        next = kind === "picture" ? { kind: "picture" } : { kind: kind === "pdf" ? "pdf" : "binary", size };
      }
      if (alive) setLoaded(next);
    })().catch((e: Error) => { if (alive && e.name !== "AbortError") setLoaded({ kind: "error", status: 0, reason: e.message }); });
    return () => { alive = false; ctl.abort(); };
  }, [url]);
  return loaded;
}

export function FileView({ project, path, line, onClose }: { project: string; path: string; line?: number; onClose: () => void }) {
  const url = fileUrl(project, path);
  const file = useFile(url);
  const markdown = isMarkdown(path);
  const [source, setSource] = useState(false);
  const folder = folderOf(path);

  if (file.kind === "picture") {
    return <ImageViewer images={[{ src: url, label: baseName(path) }]} index={0} onIndex={() => {}} onClose={onClose} context={folder || undefined} />;
  }
  const text = file.kind === "text" ? withoutFinalNewline(file.text) : "";
  const count = file.kind === "text" ? text.split("\n").length : 0;
  const where = line ? (file.kind === "text" && line > count ? t("file.lineBeyond", { line, count }) : t("file.line", { line })) : undefined;
  const meta = [folder, where, file.kind === "text" && !where ? t("file.lines", { count }) : undefined].filter(Boolean).join(" · ");

  return createPortal(
    <div role="dialog" aria-label={t("file.dialog")} className="fixed inset-0 z-[60] flex flex-col bg-canvas pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2 text-sm">
        <div className="min-w-0 flex-1 pl-1">
          <div className="truncate font-mono font-semibold text-fg" title={path}>{baseName(path)}</div>
          {meta && <div className="truncate text-xs text-fg-3" title={meta}>{meta}</div>}
        </div>
        {markdown && file.kind === "text" && (
          <div className="flex shrink-0 gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5" role="group" aria-label={t("file.show")}>
            {([[false, t("file.rendered")], [true, t("file.source")]] as const).map(([s, label]) => (
              <button key={label} onClick={() => setSource(s)} aria-pressed={source === s}
                className={`rounded-md px-3 py-1 text-xs max-lg:min-h-9 ${source === s ? "bg-surface-4 font-semibold text-fg" : "text-fg-2 hover:text-fg"}`}>{label}</button>
            ))}
          </div>
        )}
        {file.kind === "text" && (
          <a href={url} target="_blank" rel="noreferrer" title={t("file.rawTitle")} className="shrink-0 rounded-md px-2 py-1.5 text-xs text-accent hover:bg-surface-3">{t("file.raw")}</a>
        )}
        <button onClick={onClose} aria-label={t("common.close")} className="grid shrink-0 place-items-center rounded-md p-1.5 text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:h-11 max-lg:w-11">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      {file.kind === "text" && file.cut && (
        <div className="border-b border-line bg-warn/10 px-4 py-1.5 text-xs text-fg-2">{t("file.cut", { size: sizeText(file.size) })}</div>
      )}
      {file.kind === "loading" && <Note>{t("common.loading")}</Note>}
      {file.kind === "error" && (
        <Note tone="text-danger">{file.status === 404 ? t("file.notFound") : file.status === 403 ? t("file.outside") : t("file.failed", { reason: file.reason })}</Note>
      )}
      {file.kind === "pdf" && <Note>{t("file.pdf", { size: sizeText(file.size) })} <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{t("file.openPdf")}</a></Note>}
      {file.kind === "binary" && <Note>{t("file.binary", { size: sizeText(file.size) })} <a href={url} download className="text-accent hover:underline">{t("file.download")}</a></Note>}
      {file.kind === "text" && (markdown && !source
        ? <MarkdownFile project={project} path={path} text={text} line={line} />
        : <Code path={path} text={text} line={line} />)}
    </div>,
    document.body,
  );
}

const Note = ({ children, tone = "text-fg-2" }: { children: ReactNode; tone?: string }) => (
  <div className={`px-5 py-6 text-sm ${tone}`}>{children}</div>
);

/** Code with line numbers, the line asked for marked and scrolled to the middle; highlighted once the highlighter loads. */
function Code({ path, text, line }: { path: string; text: string; line?: number }) {
  const [lines, setLines] = useState<Token[][]>(() => plainLines(text));
  useEffect(() => {
    setLines(plainLines(text));
    const language = languageOf(path);
    if (!language || text.length > HIGHLIGHT_LIMIT) return;
    let alive = true;
    void import("../highlight.ts").then((m) => { if (alive) setLines(m.highlight(text, language)); });
    return () => { alive = false; };
  }, [path, text]);
  const target = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { target.current?.scrollIntoView({ block: "center" }); }, [line, text]);
  const gutter = `${String(lines.length).length + 2}ch`;
  return (
    <div className="hl scroll-thin min-h-0 flex-1 overflow-auto font-mono text-[12.5px] leading-5 text-fg">
      <div className="min-w-max py-2">
        {lines.map((tokens, i) => {
          const at = i + 1 === line;
          return (
            <div key={i} ref={at ? target : undefined} className={`flex ${at ? "bg-accent/15" : ""}`} aria-current={at ? "true" : undefined}>
              <span style={{ width: gutter }} className={`sticky left-0 shrink-0 select-none border-r pr-2 text-right ${at ? "border-accent bg-[color-mix(in_oklab,var(--color-accent)_15%,var(--color-canvas))] font-semibold text-fg" : "border-line bg-canvas text-fg-3"}`}>{i + 1}</span>
              <code className="whitespace-pre pl-3 pr-6">{tokens.map((tk, j) => (tk.cls ? <span key={j} className={tk.cls}>{tk.text}</span> : tk.text))}{tokens.length ? null : "​"}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface Block { type: string; properties?: Record<string, unknown>; position?: { start: { line: number }; end: { line: number } }; children?: Block[] }
/** A rehype step: each top-level block says which source lines it came from (data-lines="3-7"), to find a line in. */
const rehypeLines = () => (tree: Block) => {
  for (const c of tree.children ?? []) {
    if (c.type === "element" && c.position) c.properties = { ...c.properties, dataLines: `${c.position.start.line}-${c.position.end.line}` };
  }
};

/**
 * A Markdown file rendered (GitHub's tables and task lists too). Its raw HTML stays text (react-markdown renders none
 * without a raw-HTML plugin). A link to another file of the project opens that file here; a web link opens a new tab.
 * Pictures are the project's own, through the file endpoint; one from the web is not loaded. Opened at a line, the
 * block that line belongs to (or the next one, for a blank line) is marked and scrolled to the middle.
 */
function MarkdownFile({ project, path, text, line }: { project: string; path: string; text: string; line?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!line || !box.current) return;
    const blocks = [...box.current.querySelectorAll<HTMLElement>("[data-lines]")];
    const block = blocks.find((b) => Number(b.dataset.lines!.split("-")[1]) >= line) ?? blocks.at(-1);
    if (!block) return;
    block.classList.add("md-line");
    block.scrollIntoView({ block: "center" });
  }, [line, text]);
  const components = useMemo(() => ({
    a: ({ node: _n, href, children, ...p }: { node?: unknown; href?: string; children?: ReactNode }) => {
      const target = href ? relativeTarget(path, href) : undefined;
      if (target) {
        const link = `?file=${encodeURIComponent(target.path)}${target.line ? `&line=${target.line}` : ""}#/${encodeURIComponent(project)}`;
        return <a {...p} href={link} onClick={(e) => { if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); nav.file(target.path, target.line); }}>{children}</a>;
      }
      return <a {...p} href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
    img: ({ node: _n, src, alt }: { node?: unknown; src?: string | Blob; alt?: string }) => {
      const target = typeof src === "string" ? relativeTarget(path, src) : undefined;
      if (!target) return <span className="text-fg-3">{t("file.remotePicture", { alt: alt || (typeof src === "string" ? src : "") })}</span>;
      return <img src={fileUrl(project, target.path)} alt={alt ?? ""} className="max-w-full rounded-md" loading="lazy" />;
    },
  }), [project, path]);
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-8">
      <div ref={box} className="md mx-auto max-w-3xl text-sm leading-relaxed text-fg">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeLines]} components={components}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}
