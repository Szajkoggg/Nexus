// "Open in editor": the stored choice, and the link each editor gets for a file at a line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EDITOR, EDITORS, EDITOR_CHOICES, editorLink, parseEditor } from "../src/editor.ts";

const ROOT = "C:\\Code\\Nexus";
const FILE = "C:\\Code\\Nexus\\apps\\server\\src\\engine.ts";

test("the choice: VS Code by default, anything unknown is the default", () => {
  assert.equal(DEFAULT_EDITOR, "vscode");
  assert.equal(parseEditor(null), "vscode");
  assert.equal(parseEditor("emacs"), "vscode");
  for (const e of EDITORS) assert.equal(parseEditor(e), e);
  assert.deepEqual(EDITOR_CHOICES.map((c) => c.value), ["vscode", "cursor", "jetbrains", "none"]);
});

test("VS Code and Cursor: <scheme>://file/<path>:<line>, Windows and POSIX paths", () => {
  assert.equal(editorLink("vscode", FILE, 138, ROOT), "vscode://file/C:/Code/Nexus/apps/server/src/engine.ts:138");
  assert.equal(editorLink("cursor", FILE, 138, ROOT), "cursor://file/C:/Code/Nexus/apps/server/src/engine.ts:138");
  assert.equal(editorLink("vscode", FILE, undefined, ROOT), "vscode://file/C:/Code/Nexus/apps/server/src/engine.ts", "no line");
  assert.equal(editorLink("vscode", "/home/u/p/main.py", 7, "/home/u/p"), "vscode://file/home/u/p/main.py:7");
  assert.equal(editorLink("vscode", "C:\\Users\\Ádám\\my notes#1.md", 2, ROOT), "vscode://file/C:/Users/%C3%81d%C3%A1m/my%20notes%231.md:2", "encoded parts");
});

test("JetBrains: the Toolbox App's link, by the project's folder name and the path within it", () => {
  assert.equal(editorLink("jetbrains", FILE, 138, ROOT),
    "jetbrains://idea/navigate/reference?project=Nexus&path=apps%2Fserver%2Fsrc%2Fengine.ts%3A138");
  assert.equal(editorLink("jetbrains", "c:/code/nexus/README.md", undefined, ROOT + "\\"), "jetbrains://idea/navigate/reference?project=Nexus&path=README.md", "case and separators");
  assert.equal(editorLink("jetbrains", "C:\\Code\\Other\\x.ts", 1, ROOT), undefined, "outside the project: no project to name");
  assert.equal(editorLink("jetbrains", "C:\\Code\\NexusX\\x.ts", 1, ROOT), undefined, "a sibling folder with the same start");
});

test("none: no link", () => {
  assert.equal(editorLink("none", FILE, 1, ROOT), undefined);
});
