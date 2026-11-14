// "Open in editor" (queue CH3; docs/ideas/chat-improvements.md): beside the file viewer, on the server machine only, a
// link through the editor's own link scheme opens the file at the line. The editor is a setting of this browser, like
// the theme: VS Code (the default), Cursor, JetBrains, or none. Nothing on the server starts a program: the browser
// hands the link to whatever the system registered for the scheme.
//
// The pure part (parsing the stored choice, building the link) is unit tested.
import type { Key } from "./i18n.ts";

export const EDITORS = ["vscode", "cursor", "jetbrains", "none"] as const;
export type Editor = (typeof EDITORS)[number];

/** The choices offered in the settings, each with its words' key in the catalogue (messages/en.ts). */
export const EDITOR_CHOICES: { value: Editor; label: Key }[] = [
  { value: "vscode", label: "settings.editor.vscode" },
  { value: "cursor", label: "settings.editor.cursor" },
  { value: "jetbrains", label: "settings.editor.jetbrains" },
  { value: "none", label: "settings.editor.none" },
];

export const EDITOR_KEY = "nexus.editor";
export const DEFAULT_EDITOR: Editor = "vscode";

/** The stored choice; anything missing or unknown is the default. */
export const parseEditor = (raw: string | null | undefined): Editor =>
  (EDITORS as readonly string[]).includes(raw ?? "") ? (raw as Editor) : DEFAULT_EDITOR;

/** A path's parts encoded for a URL, its separators as "/" and a drive's colon kept ("C:/Code/a b.ts" → "C:/Code/a%20b.ts"). */
const encodePath = (path: string) =>
  path.replaceAll("\\", "/").split("/").map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p))).join("/");

const inside = (path: string, root: string) => {
  const p = path.replaceAll("\\", "/").toLowerCase();
  const r = root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return p.startsWith(r + "/") ? path.replaceAll("\\", "/").slice(r.length + 1) : undefined;
};

/**
 * The link that opens a file at a line in an editor, or undefined (no editor, or JetBrains for a file outside the
 * project). `path` is the file's absolute path on the server machine, `root` the project's root.
 *
 * - VS Code and Cursor: `vscode://file/<path>:<line>` and `cursor://file/<path>:<line>`.
 * - JetBrains, through the Toolbox App's scheme: `jetbrains://idea/navigate/reference?project=<the root's folder
 *   name>&path=<the path within the project>:<line>`; it names a project, so a file outside the project has none.
 */
export function editorLink(editor: Editor, path: string, line: number | undefined, root: string): string | undefined {
  const at = line && line > 0 ? `:${line}` : "";
  switch (editor) {
    case "vscode": case "cursor": {
      const p = encodePath(path);
      return `${editor}://file${p.startsWith("/") ? "" : "/"}${p}${at}`;
    }
    case "jetbrains": {
      const within = inside(path, root);
      const project = root.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1);
      if (within === undefined || !project) return undefined;
      return `jetbrains://idea/navigate/reference?project=${encodeURIComponent(project)}&path=${encodeURIComponent(within + at)}`;
    }
    case "none": return undefined;
  }
}

// ---------------------------------------------------------------- the browser

export function readEditor(): Editor {
  try { return parseEditor(localStorage.getItem(EDITOR_KEY)); } catch { return DEFAULT_EDITOR; }
}

export function setEditor(editor: Editor): void {
  try { localStorage.setItem(EDITOR_KEY, editor); } catch { /* private mode: the choice lasts until the page closes */ }
}
