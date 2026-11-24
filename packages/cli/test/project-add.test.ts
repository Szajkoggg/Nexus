// `nexus project add` prints the check of the project's rules files (AGENTS.md, pulled into CLAUDE.md) and changes
// neither file: the fix is the user's, in the dashboard. In a temporary NEXUS_HOME with temporary projects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliOut } from "./run-cli.ts";


async function add(files: { agents?: string; claude?: string }): Promise<{ out: string; root: string }> {
  const base = mkdtempSync(join(tmpdir(), "nexus-add-"));
  const root = join(base, "proj");
  mkdirSync(root);
  if (files.agents !== undefined) writeFileSync(join(root, "AGENTS.md"), files.agents);
  if (files.claude !== undefined) writeFileSync(join(root, "CLAUDE.md"), files.claude);
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_HOME: join(base, "home") };
  delete env.NEXUS_DIR; delete env.NEXUS_SESSION;
  const out = await cliOut(["project", "add", root], { env });
  return { out, root };
}

test("nexus project add prints whether each runtime would see the project's rules", async () => {
  const a = await add({ agents: "# Rules\n" });
  assert.match(a.out, /^ok: project proj/);
  assert.match(a.out, /warning: Claude Code would not see the project's rules: there is an AGENTS\.md but no CLAUDE\.md/);
  assert.match(a.out, /Fix: on the project's page in the dashboard/);
  assert.equal(existsSync(join(a.root, "CLAUDE.md")), false, "the command changes no file of the project");
  assert.match((await add({ claude: "# Rules\n" })).out, /warning: Codex would not see/);
  assert.match((await add({ agents: "x", claude: "# Claude\n" })).out, /warning: Claude Code would not see the rules in AGENTS\.md: CLAUDE\.md does not pull it in/);
  assert.match((await add({ agents: "x", claude: "# Claude\n\n@AGENTS.md\n" })).out, /rules: AGENTS\.md, pulled into CLAUDE\.md: both/);
  assert.match((await add({})).out, /rules: no AGENTS\.md or CLAUDE\.md/);
});

test("nexus project add brings a removed project back under the id its kept .nexus folder has", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-readd-"));
  const root = join(base, "Some Folder");
  mkdirSync(root);
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_HOME: join(base, "home") };
  delete env.NEXUS_DIR; delete env.NEXUS_SESSION;
  const run = async (...args: string[]) => await cliOut(["project", "add", root, ...args], { env });
  assert.match(await run("--id", "kept"), /^ok: project kept /);
  // Removed from Nexus (the registry emptied), its .nexus kept: added again without --id, it is "kept" again.
  writeFileSync(join(base, "home", "projects.yaml"), "protocol: 1\nprojects: []\n");
  assert.match(await run(), /^ok: project kept /);
  assert.match(readFileSync(join(base, "home", "projects.yaml"), "utf8"), /id: kept/);
});
