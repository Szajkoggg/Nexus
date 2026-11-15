// The file viewer's pure parts: its layer, the language of a file, the highlighter's tree as lines of escaped-text
// tokens, and where a Markdown file's relative links point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, delimiterOf, fileLayer, fileOf, folderOf, formatJson, formattedKind, languageOf, linesOf, parseTable, plainLines, relativeTarget, withoutFinalNewline } from "../src/fileview.ts";
import { highlight } from "../src/highlight.ts";
import { kindOf, layerValue, navOf } from "../src/layers.ts";

test("the layer names the file and its line, Windows paths with colons included", () => {
  assert.equal(fileLayer("apps/server/src/engine.ts", 138), "file:138:apps/server/src/engine.ts");
  assert.equal(fileLayer("docs/x.md"), "file::docs/x.md");
  assert.equal(kindOf(fileLayer("C:\\Code\\a.ts", 3)), "file");
  assert.deepEqual(fileOf("138:apps/server/src/engine.ts"), { path: "apps/server/src/engine.ts", line: 138 });
  assert.deepEqual(fileOf("3:C:\\Code\\a.ts"), { path: "C:\\Code\\a.ts", line: 3 });
  assert.deepEqual(fileOf(":C:\\Code\\a.ts"), { path: "C:\\Code\\a.ts" });
  assert.equal(fileOf(undefined), undefined);
  assert.equal(fileOf("x:"), undefined);
  assert.equal(fileLayer("a.ts", 0), "file::a.ts", "no line 0");
});

test("?file=…&line=… opens the viewer at load, over the drawer", () => {
  const n = navOf(null, "#/p/Q/Q1", "?file=apps%2Fweb%2Fsrc%2FApp.tsx&line=42");
  assert.deepEqual(n.layers, ["item", "file:42:apps/web/src/App.tsx"]);
  assert.deepEqual(fileOf(layerValue(n, "file")), { path: "apps/web/src/App.tsx", line: 42 });
  assert.deepEqual(navOf(null, "#/p", "?file=README.md&line=x").layers, ["file::README.md"]);
  assert.deepEqual(navOf(null, "#/p", "?commit=13118f1").layers, ["commit:13118f1"], "a commit's details at load");
});

test("names, folders and languages", () => {
  assert.equal(baseName("C:\\Code\\Nexus\\apps\\x.ts"), "x.ts");
  assert.equal(folderOf("apps/server/src/engine.ts"), "apps/server/src");
  assert.equal(folderOf("README.md"), "");
  assert.equal(languageOf("a/b.tsx"), "typescript");
  assert.equal(languageOf("scripts/live.ps1"), "powershell");
  assert.equal(languageOf("Dockerfile"), "dockerfile");
  assert.equal(languageOf("notes.unknown"), undefined);
  assert.equal(withoutFinalNewline("a\r\nb\r\n"), "a\nb");
});

test("the tree becomes lines; a span over several lines is cut at each line end", () => {
  const tree = { type: "root", children: [
    { type: "element", properties: { className: ["hljs-comment"] }, children: [{ type: "text", value: "/* one\ntwo */" }] },
    { type: "text", value: " x\n" },
    { type: "element", properties: { className: ["hljs-keyword"] }, children: [{ type: "text", value: "const" }] },
  ] };
  assert.deepEqual(linesOf(tree), [
    [{ text: "/* one", cls: "hljs-comment" }],
    [{ text: "two */", cls: "hljs-comment" }, { text: " x" }],
    [{ text: "const", cls: "hljs-keyword" }],
  ]);
  assert.deepEqual(plainLines("a\n\nb"), [[{ text: "a" }], [], [{ text: "b" }]]);
});

test("highlighted code keeps its text as text: markup in a string is not markup", () => {
  const code = 'const s = "<img src=x onerror=alert(1)>";\n// done';
  const lines = highlight(code, "typescript");
  assert.equal(lines.length, 2);
  assert.equal(lines.map((l) => l.map((t) => t.text).join("")).join("\n"), code, "the text is unchanged, not escaped twice, not parsed");
  assert.ok(lines[0]!.some((t) => t.cls === "hljs-keyword" && t.text === "const"));
  assert.ok(lines[0]!.some((t) => t.cls === "hljs-string" && t.text.includes("<img")));
  assert.ok(lines[1]!.every((t) => t.cls?.includes("hljs-comment")));
  assert.deepEqual(highlight("x", "no-such-language"), [[{ text: "x" }]]);
});

test("a Markdown file's relative links resolve against its folder; others are not files", () => {
  assert.deepEqual(relativeTarget("docs/ideas/a.md", "../DESIGN.md"), { path: "docs/DESIGN.md" });
  assert.deepEqual(relativeTarget("docs/ideas/a.md", "./b.md#L12"), { path: "docs/ideas/b.md", line: 12 });
  assert.deepEqual(relativeTarget("README.md", "docs/PROTOCOL.md#files-and-commits"), { path: "docs/PROTOCOL.md" });
  assert.deepEqual(relativeTarget("docs/a.md", "/apps/x.ts"), { path: "apps/x.ts" }, "from the project's root");
  assert.deepEqual(relativeTarget("C:\\Code\\Nexus\\docs\\a.md", "../README.md"), { path: "C:\\Code\\Nexus\\README.md" });
  assert.deepEqual(relativeTarget("/home/u/p/docs/a.md", "pic%20one.png"), { path: "/home/u/p/docs/pic one.png" });
  assert.equal(relativeTarget("docs/a.md", "../../outside.md"), undefined, "above the start of a relative path");
  for (const href of ["https://example.com", "mailto:x@y", "#heading", "//cdn.example.com/x.png", "javascript:alert(1)", ""]) {
    assert.equal(relativeTarget("docs/a.md", href), undefined, href);
  }
});

// ---------------------------------------------------------------- JSON and CSV

test("which files have a formatted view: Markdown, JSON, CSV and TSV; YAML and the rest only their source", () => {
  assert.equal(formattedKind("docs/a.md"), "markdown");
  assert.equal(formattedKind("C:/r/data.JSON"), "json");
  assert.equal(formattedKind("out/rows.csv"), "table");
  assert.equal(formattedKind("out/rows.tsv"), "table");
  assert.equal(formattedKind("plan.yaml"), undefined);
  assert.equal(formattedKind("events.jsonl"), undefined);
  assert.equal(delimiterOf("a.tsv"), "\t");
  assert.equal(delimiterOf("a.csv"), ",");
});

test("JSON is indented by two spaces, keys in their order, strings untouched", () => {
  assert.equal(formatJson('{"b":1,"a":[1,{"x":"a, \\"b\\"\\n"}],"e":{}}'),
    '{\n  "b": 1,\n  "a": [\n    1,\n    {\n      "x": "a, \\"b\\"\\n"\n    }\n  ],\n  "e": {}\n}');
  assert.equal(formatJson("  42 \n"), "42");
});

test("JSON that does not parse, or holds a number JavaScript cannot keep exactly, is not formatted", () => {
  assert.equal(formatJson('{"a": 1,}'), undefined);
  assert.equal(formatJson(""), undefined);
  assert.equal(formatJson('{"id": 12345678901234567890}'), undefined);
  // Long digit runs inside strings are only text.
  assert.equal(formatJson('{"id":"12345678901234567890"}'), '{\n  "id": "12345678901234567890"\n}');
});

test("CSV: the first row is the header; quotes hold commas, line ends and doubled quotes", () => {
  const t = parseTable('name,note\r\n"Smith, J.","said ""hi""\nand left"\nplain,\n');
  assert.deepEqual(t.header, ["name", "note"]);
  assert.deepEqual(t.rows, [["Smith, J.", 'said "hi"\nand left'], ["plain", ""]]);
  assert.equal(t.more, 0);
});

test("CSV: empty lines are no rows, also at the end; an empty quoted field and empty cells are kept", () => {
  const t = parseTable('\uFEFFa,b,c\n\n1,,3\n\n"",x,\n\n\n');
  assert.deepEqual(t.header, ["a", "b", "c"]);
  assert.deepEqual(t.rows, [["1", "", "3"], ["", "x", ""]]);
  assert.deepEqual(parseTable(""), { header: [], rows: [], more: 0 });
  assert.deepEqual(parseTable("only,a,header"), { header: ["only", "a", "header"], rows: [], more: 0 });
});

test("CSV: at most the limit's rows (1000 by default), the rest counted; TSV splits at tabs", () => {
  const text = ["n", ...Array.from({ length: 1005 }, (_, i) => String(i))].join("\n");
  const t = parseTable(text);
  assert.equal(t.rows.length, 1000);
  assert.deepEqual(t.rows.at(-1), ["999"]);
  assert.equal(t.more, 5);
  assert.deepEqual(parseTable("a\nb\nc\nd", { limit: 2 }), { header: ["a"], rows: [["b"], ["c"]], more: 1 });
  assert.deepEqual(parseTable("a\tb,c\n1\t2,3", { delimiter: "\t" }), { header: ["a", "b,c"], rows: [["1", "2,3"]], more: 0 });
});
