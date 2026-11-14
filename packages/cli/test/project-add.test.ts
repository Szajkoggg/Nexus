// `nexus project add` prints the check of the project's rules files (AGENTS.md, pulled into CLAUDE.md) and changes
// neither file: the fix is the user's, in the dashboard. In a temporary NEXUS_HOME with temporary projects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

function add(files: { agents?: string; claude?: string }): { out: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "nexus-add-"));
  const root = join(base, "proj");
  mkdirSync(root);
  if (files.agents !== undefined) writeFileSync(join(root, "AGENTS.md"), files.agents);
  if (files.claude !== undefined) writeFileSync(join(root, "CLAUDE.md"), files.claude);
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_HOME: join(base, "home") };
  delete env.NEXUS_DIR; delete env.NEXUS_SESSION;
  const out = execFileSync(process.execPath, [CLI, "project", "add", root], { env, encoding: "utf8" });
  return { out, root };
}

test("nexus project add prints whether each runtime would see the project's rules", () => {
  const a = add({ agents: "# Rules\n" });
  assert.match(a.out, /^ok: project proj/);
  assert.match(a.out, /warning: Claude Code would not see the project's rules: there is an AGENTS\.md but no CLAUDE\.md/);
  assert.match(a.out, /Fix: on the project's page in the dashboard/);
  assert.equal(existsSync(join(a.root, "CLAUDE.md")), false, "the command changes no file of the project");
  assert.match(add({ claude: "# Rules\n" }).out, /warning: Codex would not see/);
  assert.match(add({ agents: "x", claude: "# Claude\n" }).out, /warning: Claude Code would not see the rules in AGENTS\.md: CLAUDE\.md does not pull it in/);
  assert.match(add({ agents: "x", claude: "# Claude\n\n@AGENTS.md\n" }).out, /rules: AGENTS\.md, pulled into CLAUDE\.md: both/);
  assert.match(add({}).out, /rules: no AGENTS\.md or CLAUDE\.md/);
});
