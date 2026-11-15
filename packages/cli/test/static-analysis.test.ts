// `nexus static-analysis [status]|decline` (queue MT, PROTOCOL.md "Static analysis reminder"): status reads the project
// and the server's note; the orchestrator's decline goes to the server as a static_analysis.declined event (played here
// by a stand-in that records it as applied); a worker's decline is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, now } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-static-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  for (const [id, role] of [["o", "orchestrator"], ["w", "worker"]] as const) {
    store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: now() });
  }
  const env = (session: string): NodeJS.ProcessEnv => ({ ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session, NEXUS_HOME: join(root, "home") });
  const run = (session: string, ...a: string[]) => {
    try { return { out: execFileSync(process.execPath, [CLI, ...a], { cwd: root, env: env(session), encoding: "utf8", stdio: "pipe" }), err: "" }; }
    catch (e) { return { out: "", err: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  return { root, store, env, run };
}

test("status: the stacks, what was found and the reminder's note", () => {
  const x = setup();
  const out = x.run("w", "static-analysis").out;
  assert.match(out, /^stacks: node$/m);
  assert.match(out, /^static analysis: none found$/m);
  assert.match(out, /^next reminder: when the server next looks$/m);
  x.store.writeStaticAnalysisNote({ protocol: 1, reminded_at: "2026-11-01T10:00:00.000Z", declined: { at: "2026-11-02T10:00:00.000Z", reason: "not now" } });
  writeFileSync(join(x.root, "eslint.config.js"), "export default [];\n");
  const after = x.run("w", "static-analysis", "status").out;
  assert.match(after, /^static analysis: eslint.config.js: linter config$/m);
  assert.match(after, /^last reminder: 2026-11-01T10:00:00.000Z$/m);
  assert.match(after, /^declined: 2026-11-02T10:00:00.000Z \(not now\)$/m);
});

test("decline: the orchestrator's goes to the server with the reason; a worker's, or one without a reason, is refused", async () => {
  const x = setup();
  assert.match(x.run("w", "static-analysis", "decline", "--reason", "no").err, /only an orchestrator session may do this/);
  assert.match(x.run("o", "static-analysis", "decline").err, /--reason/);
  const child = new Promise<string>((ok) => execFile(process.execPath, [CLI, "static-analysis", "decline", "--reason", "we lint in CI"], { cwd: x.root, env: x.env("o"), encoding: "utf8" }, (e, out, err) => ok(e ? `ERR ${err}` : out)));
  let done = false;
  void child.then(() => { done = true; });
  while (!done) {
    const applied = new Set(x.store.readApplied("o").entries.map((a) => a.event));
    for (const e of x.store.readEvents("o").entries) {
      if (e.type === "static_analysis.declined" && !applied.has(e.id)) x.store.appendApplied("o", { at: now(), event: e.id, ok: true, message: "noted: the user declined setting up static analysis" });
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(await child, /^ok: noted: the user declined setting up static analysis/);
  const e = x.store.readEvents("o").entries.find((y) => y.type === "static_analysis.declined");
  assert.equal(e?.type === "static_analysis.declined" && e.reason, "we lint in CI");
});
