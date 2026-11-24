// `nexus doc` (queue ND): a Markdown file's headings, or one section of it by name, anchor or date; the notes folder
// may be left out; an unknown section lists the sections; a `#` line in a fenced code block is no heading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@nexus/protocol";
import { cliOut } from "./run-cli.ts";


const NOTE = [
  "# Agent standards",
  "",
  "Intro.",
  "",
  "## Decided",
  "",
  "### 2026-11-14",
  "",
  "- **Summaries.** Four parts.",
  "",
  "```sh",
  "# not a heading",
  "## nor this",
  "```",
  "",
  "### 2026-11-14 (later): questions",
  "",
  "- **Questions.** Three parts.",
  "",
  "### 2026-11-15",
  "",
  "- **Context.**",
  "",
  "## Open questions",
  "",
  "~~~",
  "### 2026-11-30",
  "~~~",
  "Last line.",
  "",
].join("\r\n");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-doc-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
  mkdirSync(join(root, "docs/ideas"), { recursive: true });
  writeFileSync(join(root, "docs/ideas/agent-standards.md"), NOTE);
  // No session: the command is any role's, and reads only.
  const doc = async (...args: string[]) => {
    try {
      return { ok: true, out: await cliOut(["doc", ...args], { env: { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "" }, cwd: join(root, "docs") }) };
    } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  return { root, doc };
}

test("nexus doc lists the headings with their levels and lines, none from a code block", async () => {
  const { doc } = setup();
  const r = await doc("docs/ideas/agent-standards.md");
  assert.ok(r.ok, r.out);
  assert.equal(r.out.trimEnd(), [
    "# Agent standards  (line 1)",
    "  ## Decided  (line 5)",
    "    ### 2026-11-14  (line 7)",
    "    ### 2026-11-14 (later): questions  (line 16)",
    "    ### 2026-11-15  (line 20)",
    "  ## Open questions  (line 24)",
  ].join("\n"));
  assert.equal((await doc("agent-standards.md")).out, r.out, "the notes folder may be left out");
  assert.equal((await doc("ideas/agent-standards.md")).out, r.out, "a path from the working directory");
});

test("nexus doc <file>#<section> prints one section by its name, anchor or date", async () => {
  const { doc } = setup();
  const byName = await doc("agent-standards.md#Open questions");
  assert.ok(byName.ok, byName.out);
  assert.equal(byName.out.trimEnd(), "## Open questions\n\n~~~\n### 2026-11-30\n~~~\nLast line.");
  assert.equal((await doc("agent-standards.md#open-questions")).out, byName.out, "by its anchor");
  const decided = (await doc("agent-standards.md#decided")).out;
  assert.match(decided, /^## Decided\n[\s\S]*# not a heading\n## nor this\n[\s\S]*- \*\*Context\.\*\*$/m, "to the next heading of its level, code included");
  assert.doesNotMatch(decided, /Open questions/);

  const date = await doc("agent-standards.md#2026-11-14");
  assert.ok(date.ok, date.out);
  assert.match(date.out, /^### 2026-11-14\n[\s\S]*## nor this\n```\n\n### 2026-11-14 \(later\): questions\n\n- \*\*Questions\.\*\* Three parts\.\n$/, "every heading of the date, one entry");
  assert.doesNotMatch(date.out, /2026-11-15/);
  assert.equal((await doc("agent-standards.md#2026-11-15")).out.trimEnd(), "### 2026-11-15\n\n- **Context.**");
});

test("nexus doc refuses an unknown section, listing the sections and dates, and a missing file", async () => {
  const { root, doc } = setup();
  const r = await doc("agent-standards.md#2026-11-30");
  assert.ok(!r.ok);
  assert.match(r.out, /has no section "2026-11-30" \(its sections: Agent standards; Decided; 2026-11-14; 2026-11-14 \(later\): questions; 2026-11-15; Open questions; its dates: 2026-11-14, 2026-11-15\)/);
  assert.match((await doc("agent-standards.md#Nothing")).out, /has no section "Nothing"/);
  assert.match((await doc("agent-standards.md#Open")).out, /^## Open questions\n/, "the one heading that begins with the name");
  assert.match((await doc("agent-standards.md#Agent stand")).out, /has no section "Agent stand"/, "only whole words");
  assert.match((await doc("agent-standards.md#2026-11-14 (later)")).out, /^### 2026-11-14 \(later\): questions\n[^#]*$/, "a dated heading alone, by its text");
  writeFileSync(join(root, "x.md"), "# Static analysis (queue SA)\n\n# Static analysis (queue SB)\n");
  const several = await doc("x.md#static analysis");
  assert.ok(!several.ok);
  assert.match(several.out, /"static analysis" begins several headings: Static analysis \(queue SA\) \(line 1\); Static analysis \(queue SB\) \(line 3\); give one in full/);
  const missing = await doc("nope.md");
  assert.ok(!missing.ok);
  assert.match(missing.out, /no such file: nope\.md \(looked at /);
});
