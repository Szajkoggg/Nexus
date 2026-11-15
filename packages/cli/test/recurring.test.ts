// `nexus recurring set|list` (queue TQ, PROTOCOL.md "Recurring queues"): the orchestrator's set goes to the server as
// a recurring.set event, which carries no approval; approving, pausing and removing are the user's, refused from any
// session; `list` shows each recurring's state. The server's part is played by a stand-in that records the event as
// applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, now } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-recurring-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  for (const [id, role] of [["o", "orchestrator"], ["w", "worker"]] as const) {
    store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: now() });
  }
  const env = (session: string): NodeJS.ProcessEnv => ({ ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session, NEXUS_HOME: join(root, "home") });
  const run = (session: string, ...a: string[]) => {
    try { return { out: execFileSync(process.execPath, [CLI, ...a], { cwd: root, env: env(session), encoding: "utf8", stdio: "pipe" }), err: "" }; }
    catch (e) { return { out: "", err: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  /** The orchestrator's command while a stand-in for the server records its recurring.set events as applied. */
  const set = async (...a: string[]): Promise<string> => {
    const child = new Promise<string>((ok) => execFile(process.execPath, [CLI, "recurring", "set", ...a], { cwd: root, env: env("o"), encoding: "utf8" }, (e, out, err) => ok(e ? `ERR ${err}` : out)));
    let done = false;
    void child.then(() => { done = true; });
    while (!done) {
      const applied = new Set(store.readApplied("o").entries.map((x) => x.event));
      for (const e of store.readEvents("o").entries) {
        if (e.type === "recurring.set" && !applied.has(e.id)) store.appendApplied("o", { at: now(), event: e.id, ok: true, message: `recurring ${e.recurring} set` });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return child;
  };
  return { store, run, set };
}

test("the orchestrator's set goes to the server as an event with the template, the values and the schedule", async () => {
  const x = setup();
  assert.match(await x.set("weekly", "--template", "maintenance", "--set", "scope=dependencies", "--every", "mon 03:00", "--reason", "the user asked"), /^ok: recurring weekly set/);
  const e = x.store.readEvents("o").entries.find((y) => y.type === "recurring.set");
  assert.deepEqual(e && { recurring: e.recurring, template: e.template, params: e.params, every: e.every, reason: e.reason },
    { recurring: "weekly", template: "maintenance", params: { scope: "dependencies" }, every: "mon 03:00", reason: "the user asked" });
  assert.equal(JSON.stringify(e).includes("approv"), false, "no approval in it");
});

test("a bad schedule, a worker's set, and approving, pausing or removing from any session are refused", () => {
  const x = setup();
  assert.match(x.run("o", "recurring", "set", "R", "--template", "spike", "--every", "weekly 03:00").err, /the schedule is "daily HH:MM"/);
  assert.match(x.run("o", "recurring", "set", "R", "--template", "spike").err, /missing --every/);
  assert.match(x.run("w", "recurring", "set", "R", "--template", "spike", "--every", "daily 03:00").err, /only an orchestrator session may do this/);
  for (const [sub, word] of [["approve", "approving"], ["pause", "pausing or resuming"], ["resume", "pausing or resuming"], ["remove", "removing"]]) {
    for (const session of ["o", "w"]) assert.match(x.run(session, "recurring", sub!, "R").err, new RegExp(`${word} a recurring queue is the user's, in the dashboard`));
  }
  assert.deepEqual(x.store.readEvents("o").entries.filter((e) => e.type === "recurring.set"), []);
});

test("list shows each recurring with its template, schedule and state", () => {
  const x = setup();
  assert.match(x.run("o", "recurring", "list").out, /^no recurring queues/);
  const at = new Date().toISOString();
  x.store.writeRecurring({ protocol: 1, id: "weekly", template: "maintenance", params: { scope: "deps" }, every: "mon 03:00", set_by: "orchestrator", created_at: at, updated_at: at });
  x.store.writeRecurring({ protocol: 1, id: "gone", template: "nope", params: {}, every: "daily 03:00", set_by: "orchestrator", created_at: at, updated_at: at });
  const out = x.run("w", "recurring", "list").out;
  assert.match(out, /^weekly: template maintenance \(scope=deps\), mon 03:00; waits for the user's approval; next \S+$/m);
  assert.match(out, /^gone: template nope, daily 03:00; cannot run: no template nope$/m);
});
