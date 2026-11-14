// The file viewer's pure parts (components/FileView.tsx): the layer that names a file and its line, the language a
// file is highlighted as, the highlighter's syntax tree split into lines of tokens, and the paths a Markdown file's
// relative links and pictures point to. No React, no DOM; unit tested.

/** The viewer is a layer in the history (layers.ts): "file:<line>:<path>", the line empty when none was given. */
export const fileLayer = (path: string, line?: number) => `file:${line && line > 0 ? Math.floor(line) : ""}:${path}`;

/** The file and line of a file layer's value (what follows "file:"), or undefined for a malformed one. */
export function fileOf(value: string | undefined): { path: string; line?: number } | undefined {
  const m = value === undefined ? null : /^(\d*):([\s\S]+)$/.exec(value);
  if (!m) return undefined;
  const line = m[1] ? Number(m[1]) : undefined;
  return { path: m[2]!, ...(line ? { line } : {}) };
}

/** The file's name, the last part of its path. */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
/** The folder it is in, as written (empty for a bare name). */
export const folderOf = (path: string) => { const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")); return i > 0 ? path.slice(0, i) : ""; };
const extOf = (path: string) => { const n = baseName(path).toLowerCase(); const i = n.lastIndexOf("."); return i > 0 ? n.slice(i + 1) : n; };

export const isMarkdown = (path: string) => ["md", "markdown"].includes(extOf(path));

/** Highlight.js languages by extension (or a whole name such as Dockerfile); others are shown as plain text. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", md: "markdown",
  markdown: "markdown", css: "css", scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell", py: "python", rb: "ruby", go: "go",
  rs: "rust", java: "java", kt: "kotlin", cs: "csharp", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", swift: "swift",
  php: "php", sql: "sql", toml: "ini", ini: "ini", diff: "diff", patch: "diff", lua: "lua", r: "r", vbs: "vbscript",
  dockerfile: "dockerfile", makefile: "makefile", gitignore: "bash", gitattributes: "bash",
};
export const languageOf = (path: string): string | undefined => LANGUAGES[extOf(path)];

// ---------------------------------------------------------------- the highlighter's tree, as lines

/** A highlighter's syntax tree (lowlight's hast): elements with classes, and text. */
export interface Hast { type: string; value?: string; properties?: { className?: unknown }; children?: Hast[] }
/** A piece of a line: its text and the highlight classes it sits in (none for plain text). */
export interface Token { text: string; cls?: string }

/**
 * The tree flattened into lines of tokens, each token keeping the classes of every element around it. A span that
 * runs over several lines (a block comment, a template string) is cut at each line end, so every line stands alone.
 */
export function linesOf(tree: Hast): Token[][] {
  const lines: Token[][] = [[]];
  const walk = (node: Hast, classes: string[]) => {
    if (node.type === "text") {
      const parts = (node.value ?? "").split("\n");
      parts.forEach((text, i) => {
        if (i > 0) lines.push([]);
        if (text) lines.at(-1)!.push(classes.length ? { text, cls: classes.join(" ") } : { text });
      });
      return;
    }
    const own = node.properties?.className;
    const next = Array.isArray(own) ? [...classes, ...own.map(String)] : classes;
    for (const c of node.children ?? []) walk(c, next);
  };
  walk(tree, []);
  return lines;
}

/** Plain text as lines of one token each (no language, or too long to highlight). */
export const plainLines = (text: string): Token[][] => text.split("\n").map((l) => (l ? [{ text: l }] : []));

/** A file's text without its last line end, so a file ending in a newline does not show an empty last line. */
export const withoutFinalNewline = (text: string) => text.replace(/\r?\n$/, "").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------- Markdown's relative links

/**
 * Where a Markdown file's link or picture points: a path for one relative to the file (to open in the viewer), or
 * undefined for anything else (a web link, an anchor, mailto:). `..` is resolved here, since the server follows none.
 */
export function relativeTarget(file: string, href: string): { path: string; line?: number } | undefined {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return undefined;
  const [raw, hash] = href.split("#", 2) as [string, string | undefined];
  let target: string;
  try { target = decodeURIComponent(raw.split("?")[0]!); } catch { target = raw; }
  if (!target) return undefined;
  const lineMatch = hash ? /^L(\d+)/.exec(hash) : null;
  const sep = file.includes("\\") && !file.includes("/") ? "\\" : "/";
  const folder = folderOf(file);
  const base = target.startsWith("/") || !folder ? [] : folder.split(/[\\/]/);
  const parts: string[] = [];
  const lead = base[0] === "" ? [""] : []; // an absolute POSIX path keeps its root
  for (const p of [...base.filter(Boolean), ...target.split(/[\\/]/)]) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (parts.length) parts.pop(); else return undefined; } else parts.push(p);
  }
  if (!parts.length) return undefined;
  return { path: [...lead, ...parts].join(sep), ...(lineMatch ? { line: Number(lineMatch[1]) } : {}) };
}
