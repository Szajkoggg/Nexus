// The fix of a project's rules files (src/rulesfix.ts) on temporary projects: each fix writes the decided files, byte
// for byte (line endings and BOM kept); it is refused while a run in the project's own checkout is not finished, when
// the files changed since the user saw the change, and over the API for any request that is not the dashboard's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionError, ProjectStore, newId, now, writeRegistry, type RunFile } from "@nexus/protocol";
import { fixProjectRules, projectRules } from "../src/rulesfix.ts";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

function project(files: { agents?: Buffer | string; claude?: Buffer | string }) {
  const base = mkdtempSync(join(tmpdir(), "nexus-rules-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  if (files.agents !== undefined) writeFileSync(join(root, "AGENTS.md"), files.agents);
  if (files.claude !== undefined) writeFileSync(join(root, "CLAUDE.md"), files.claude);
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  return { root, store };
}

const bytes = (root: string, name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name)) : undefined);
const fix = (store: ProjectStore, root: string) => fixProjectRules(store, projectRules(root).version);

test("only AGENTS.md: CLAUDE.md is created with @AGENTS.md, in AGENTS.md's line endings", () => {
  const agents = Buffer.from("# Rules\r\n- one\r\n");
  const { root, store } = project({ agents });
  assert.equal(projectRules(root).state, "only-agents");
  assert.match(fix(store, root), /CLAUDE\.md created; nothing is committed/);
  assert.deepEqual(bytes(root, "AGENTS.md"), agents, "AGENTS.md is untouched");
  assert.equal(bytes(root, "CLAUDE.md")!.toString("utf8"), "@AGENTS.md\r\n");
  assert.equal(projectRules(root).state, "linked");
});

test("only CLAUDE.md: its content moves into a new AGENTS.md, byte for byte; CLAUDE.md becomes @AGENTS.md with its BOM", () => {
  const claude = Buffer.concat([BOM, Buffer.from("# Rules\r\n\r\n- é, ő\r\n")]);
  const { root, store } = project({ claude });
  assert.equal(projectRules(root).state, "only-claude");
  assert.match(fix(store, root), /AGENTS\.md created, CLAUDE\.md changed/);
  assert.deepEqual(bytes(root, "AGENTS.md"), claude);
  assert.deepEqual(bytes(root, "CLAUDE.md"), Buffer.concat([BOM, Buffer.from("@AGENTS.md\r\n")]));
  assert.equal(projectRules(root).state, "linked");
});

test("both, not linked: @AGENTS.md becomes CLAUDE.md's first line, after the BOM, in its line endings", () => {
  const claude = Buffer.concat([BOM, Buffer.from("# Claude\r\nrules\r\n")]);
  const { root, store } = project({ agents: "# Rules\n", claude });
  assert.equal(projectRules(root).state, "unlinked");
  fix(store, root);
  assert.deepEqual(bytes(root, "CLAUDE.md"), Buffer.concat([BOM, Buffer.from("@AGENTS.md\r\n# Claude\r\nrules\r\n")]));
  assert.equal(projectRules(root).state, "linked");
  // Linked now: nothing more to fix.
  assert.throws(() => fix(store, root), (e: ActionError) => e.status === 409 && /nothing to fix/.test(e.message));
});

test("both linked (Nexus's own CLAUDE.md) and neither: nothing to fix", () => {
  const nexus = readFileSync(join(import.meta.dirname, "../../../CLAUDE.md"));
  const a = project({ agents: "# Rules\n", claude: nexus });
  assert.equal(projectRules(a.root).state, "linked");
  assert.throws(() => fix(a.store, a.root), /nothing to fix/);
  const b = project({});
  assert.equal(projectRules(b.root).state, "neither");
  assert.throws(() => fix(b.store, b.root), /nothing to fix/);
});

test("refused while a run in the project's own checkout is not finished; a run elsewhere does not block it", () => {
  const { root, store } = project({ agents: "# Rules\n" });
  const queue = (id: string, worktree?: string) => store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "proposed", stop_conditions: [], checks: [], worktree,
    steps: [{ id: `${id}1`, title: "One", goal: "", acceptance: [] }] });
  const run = (id: string, state: RunFile["state"]) => store.writeRun(id, { protocol: 1, session: newId(), state, started_at: now(), updated_at: now() });
  queue("A"); queue("W", join(root, "..", "elsewhere"));
  run("W", "running");
  for (const state of ["running", "paused", "usage_wait", "approval_wait"] as const) {
    run("A", state);
    assert.throws(() => fix(store, root), (e: ActionError) => e.status === 409 && e.message.includes("queue A's run is not finished") && e.message.includes(state), state);
    assert.equal(bytes(root, "CLAUDE.md"), undefined, "nothing was written");
  }
  run("A", "finished");
  fix(store, root);
  assert.equal(bytes(root, "CLAUDE.md")!.toString(), "@AGENTS.md\n");
});

test("refused when the files changed since the change was shown, or a file is not UTF-8", () => {
  const { root, store } = project({ agents: "# Rules\n", claude: "# Claude\n" });
  const seen = projectRules(root).version;
  writeFileSync(join(root, "CLAUDE.md"), "# Claude, edited\n");
  assert.throws(() => fixProjectRules(store, seen), (e: ActionError) => e.status === 409 && /changed since/.test(e.message));
  assert.throws(() => fixProjectRules(store, undefined), /changed since/);
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# Claude, edited\n");
  writeFileSync(join(root, "CLAUDE.md"), Buffer.from([0x23, 0x20, 0xe9, 0x0a])); // Latin-1 "# é"
  assert.throws(() => fix(store, root), /not UTF-8/);
  assert.deepEqual(readFileSync(join(root, "CLAUDE.md")), Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
});

test("the API: the check for anyone on this machine, the fix only from the dashboard's page", async () => {
  const { root } = project({ agents: "# Rules\n" });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/projects/p/rules/fix`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    await serverUp(base + "/api/projects");
    const check = await (await fetch(`${base}/api/projects/p/rules`)).json() as { state: string; version: string; unseen_by: string };
    assert.equal(check.state, "only-agents");
    assert.equal(check.unseen_by, "claude");

    // An agent's script or curl: no Origin. A request not from the page itself. Another site.
    for (const headers of [{}, { origin: base, "sec-fetch-site": "none" }, { origin: "http://evil.example" }] as Record<string, string>[]) {
      const r = await post({ version: check.version }, headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
    }
    assert.equal(bytes(root, "CLAUDE.md"), undefined, "nothing was written");

    const r = await post({ version: check.version }, { origin: base, "sec-fetch-site": "same-origin" });
    assert.equal(r.status, 200, await r.clone().text());
    assert.match(((await r.json()) as { result: { message: string } }).result.message, /CLAUDE\.md created/);
    assert.equal(bytes(root, "CLAUDE.md")!.toString(), "@AGENTS.md\n");
  } finally {
    child.kill();
  }
});
