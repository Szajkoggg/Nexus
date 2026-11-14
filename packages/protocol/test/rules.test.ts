// The check of a project's rules files (src/rules.ts): which runtime would not see the rules, and the fix it offers,
// with the files' line endings and BOM kept. Pure: contents in, result out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRules, claudeImports, describeRules, isLinked } from "../src/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BOM = String.fromCharCode(0xfeff);

test("only AGENTS.md: Claude Code would not see the rules; the fix creates CLAUDE.md with @AGENTS.md", () => {
  const c = checkRules({ agents: "# Rules\n\n- one\n" });
  assert.equal(c.state, "only-agents");
  assert.equal(c.unseen_by, "claude");
  assert.deepEqual(c.fix!.changes, [{ file: "CLAUDE.md", action: "create", after: "@AGENTS.md\n" }]);
  // AGENTS.md's line endings are the new file's.
  assert.equal(checkRules({ agents: "# Rules\r\n- one\r\n" }).fix!.changes[0]!.after, "@AGENTS.md\r\n");
  assert.match(describeRules(c), /^warning: Claude Code would not see/);
});

test("only CLAUDE.md: Codex would not see the rules; the fix moves its content and leaves @AGENTS.md", () => {
  const claude = `${BOM}# Rules\r\n\r\nSee @docs/style.md and \`@not/this.md\`.\r\n\r\n\`\`\`\r\n@fenced/file.md\r\n\`\`\`\r\n`;
  const c = checkRules({ claude });
  assert.equal(c.state, "only-claude");
  assert.equal(c.unseen_by, "codex");
  const [agents, newClaude] = c.fix!.changes;
  assert.deepEqual(agents, { file: "AGENTS.md", action: "create", after: claude }, "moved byte for byte, BOM and CRLF too");
  assert.deepEqual(newClaude, { file: "CLAUDE.md", action: "replace", before: claude, after: `${BOM}@AGENTS.md\r\n` });
  assert.deepEqual(c.fix!.imports, ["@docs/style.md"], "imports outside code are named for the confirmation");
  assert.match(describeRules(c), /^warning: Codex would not see/);
});

test("a CLAUDE.md that holds only the link and no AGENTS.md: no rules to move, nothing to warn about", () => {
  assert.equal(checkRules({ claude: "@AGENTS.md\n" }).state, "neither");
  // With rules beside the link, the link line is not moved into AGENTS.md (it would import the file itself).
  const c = checkRules({ claude: "@AGENTS.md\n# Rules\n- one\n" });
  assert.equal(c.state, "only-claude");
  assert.equal(c.fix!.changes[0]!.after, "# Rules\n- one\n");
});

test("both, linked: Nexus's own CLAUDE.md, a link after a heading and text, and @./AGENTS.md", () => {
  const nexus = readFileSync(join(here, "../../../CLAUDE.md"), "utf8");
  const c = checkRules({ agents: readFileSync(join(here, "../../../AGENTS.md"), "utf8"), claude: nexus });
  assert.equal(c.state, "linked");
  assert.equal(c.fix, undefined);
  assert.equal(c.unseen_by, undefined);
  assert.ok(isLinked("# Project\n\nSome text.\n\n  @./AGENTS.md  \n\nMore.\n"));
  assert.ok(isLinked(`${BOM}@AGENTS.md\r\n# Claude only\r\n`));
  assert.match(describeRules(c), /both Claude Code and Codex see them/);
});

test("both, not linked: the fix adds @AGENTS.md as CLAUDE.md's first line, keeping its line endings and BOM", () => {
  for (const claude of ["# Claude\n\nRead AGENTS.md please.\n", "```\n@AGENTS.md\n```\n", "Text @AGENTS.md in a sentence\n"]) {
    const c = checkRules({ agents: "# Rules\n", claude });
    assert.equal(c.state, "unlinked", claude);
    assert.equal(c.unseen_by, "claude");
    assert.deepEqual(c.fix!.changes, [{ file: "CLAUDE.md", action: "replace", before: claude, after: `@AGENTS.md\n${claude}` }]);
  }
  const crlf = `${BOM}# Claude\r\nrules\r\n`;
  assert.equal(checkRules({ agents: "x", claude: crlf }).fix!.changes[0]!.after, `${BOM}@AGENTS.md\r\n# Claude\r\nrules\r\n`);
  assert.equal(checkRules({ agents: "x", claude: "" }).fix!.changes[0]!.after, "@AGENTS.md\n");
  // A fence closed by a shorter or other marker is still open.
  assert.equal(isLinked("````\n```\n@AGENTS.md\n````\n"), false);
  assert.equal(isLinked("~~~\n@AGENTS.md\n~~~\n@AGENTS.md\n"), true);
});

test("neither: no warning", () => {
  const c = checkRules({});
  assert.deepEqual(c, { state: "neither", agents: false, claude: false });
  assert.match(describeRules(c), /^rules: no AGENTS.md or CLAUDE.md/);
});

test("imports: paths only, not mentions or e-mail addresses", () => {
  assert.deepEqual(claudeImports("Ask @alice. Mail a@b.com. Read @~/x.md, @README.md and @docs/a.md.\n"), ["@~/x.md", "@README.md", "@docs/a.md"]);
});
