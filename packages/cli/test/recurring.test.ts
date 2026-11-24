// `nexus recurring set|list` (queue TQ, docs/protocol/planning.md "Recurring queues"): the orchestrator's set goes to the server as
// a recurring.set event, which carries no approval; approving, pausing and removing are the user's, refused from any
// session; `list` shows each recurring's state. The server's part is played by a stand-in that records the event as
// applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, now } from "@nexus/protocol";
import { cliOut, cliRun } from "./run-cli.ts";


function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-recurring-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  for (const [id, role] of [["o", "orchestrator"], ["w", "worker"]] as const) {
    store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: now() });
  }
  const env = (session: string): NodeJS.ProcessEnv => ({ ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session, NEXUS_HOME: join(root, "home") });
  const run = async (session: string, ...a: string[]) => {
    try { return { out: await cliOut([...a], { cwd: root, env: env(session) }), err: "" }; }
    catch (e) { return { out: "", err: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  /** The orchestrator's command while a stand-in for the server records its recurring.set events as applied. */
  const set = async (...a: string[]): Promise<string> => {
    const child = cliRun(["recurring", "set", ...a], { cwd: root, env: env("o") }).then((r) => (r.status ? `ERR ${r.stderr}` : r.stdout));
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
  assert.match(await x.set("every5", "--template", "maintenance", "--after-queues", "5", "--maintenance", "fix_small"), /^ok: recurring every5 set/);
  const e5 = x.store.readEvents("o").entries.findLast((y) => y.type === "recurring.set");
  assert.deepEqual(e5 && { every: e5.every, after_queues: e5.after_queues, maintenance: e5.maintenance }, { every: undefined, after_queues: 5, maintenance: "fix_small" });
});

test("a bad schedule, a worker's set, and approving, pausing or removing from any session are refused", async () => {
  const x = setup();
  assert.match((await x.run("o", "recurring", "set", "R", "--template", "spike", "--every", "weekly 03:00")).err, /the schedule is "daily HH:MM"/);
  assert.match((await x.run("o", "recurring", "set", "R", "--template", "spike")).err, /give --every .* or --after-queues <n>: one of them/);
  assert.match((await x.run("o", "recurring", "set", "R", "--template", "spike", "--every", "daily 03:00", "--after-queues", "5")).err, /one of them/);
  assert.match((await x.run("o", "recurring", "set", "R", "--template", "spike", "--after-queues", "0")).err, /--after-queues takes a whole number from 1 to 1000/);
  assert.match((await x.run("o", "recurring", "set", "R", "--template", "maintenance", "--after-queues", "5", "--maintenance", "all")).err, /--maintenance is survey or fix_small/);
  assert.match((await x.run("w", "recurring", "set", "R", "--template", "spike", "--every", "daily 03:00")).err, /only an orchestrator session may do this/);
  for (const [sub, word] of [["approve", "approving"], ["pause", "pausing or resuming"], ["resume", "pausing or resuming"], ["remove", "removing"]]) {
    for (const session of ["o", "w"]) assert.match((await x.run(session, "recurring", sub!, "R")).err, new RegExp(`${word} a recurring queue is the user's, in the dashboard`));
  }
  assert.deepEqual(x.store.readEvents("o").entries.filter((e) => e.type === "recurring.set"), []);
});

test("list shows each recurring with its template, schedule and state", async () => {
  const x = setup();
  assert.match((await x.run("o", "recurring", "list")).out, /^no recurring queues/);
  const at = new Date().toISOString();
  x.store.writeRecurring({ protocol: 1, id: "weekly", template: "maintenance", params: { scope: "deps" }, every: "mon 03:00", set_by: "orchestrator", created_at: at, updated_at: at });
  x.store.writeRecurring({ protocol: 1, id: "gone", template: "nope", params: {}, every: "daily 03:00", set_by: "orchestrator", created_at: at, updated_at: at });
  const out = (await x.run("w", "recurring", "list")).out;
  assert.match(out, /^weekly: template maintenance \(scope=deps\), mon 03:00; waits for the user's approval; next \S+$/m);
  assert.match(out, /^gone: template nope, daily 03:00; cannot run: no template nope$/m);
});
