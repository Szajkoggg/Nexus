// `nexus queue set … skipped --continued-in`: the orchestrator's skip that says where the step's work went on goes to
// the server as `status.set` with `continued_in`, and `nexus status` shows the mark.
import { errorText } from "@nexus/protocol/errors";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, now, orchestratorStatusChange } from "@nexus/protocol";
import { cliOut, cliRun } from "./run-cli.ts";


function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-queue-set-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: now() });
  store.writeQueue({
    protocol: 1, id: "FL", title: "Flaky", revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: ["FL1", "FL2", "FL3", "FL4", "FL5"].map((id) => ({ id, title: `Step ${id}`, goal: "", acceptance: [] })),
  });
  approveQueue(store, "FL");
  const env = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "o", NEXUS_HOME: join(root, "home") };
  const run = async (...a: string[]) => {
    try { return { out: await cliOut([...a], { cwd: root, env }), err: "" }; }
    catch (e) { return { out: "", err: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  /** The command while a stand-in for the server applies its status.set as the server does, and records the result. */
  const set = async (...a: string[]): Promise<string> => {
    const child = cliRun(["queue", "set", ...a], { cwd: root, env }).then((r) => (r.status ? `ERR ${r.stderr}` : r.stdout));
    let done = false;
    void child.then(() => { done = true; });
    while (!done) {
      const applied = new Set(store.readApplied("o").entries.map((x) => x.event));
      for (const e of store.readEvents("o").entries) {
        if (e.type !== "status.set" || applied.has(e.id)) continue;
        try {
          const message = orchestratorStatusChange(store, { queue: e.queue, step: e.step, to: e.to, reason: e.reason, continued_in: e.continued_in });
          store.appendApplied("o", { at: now(), event: e.id, ok: true, message });
        } catch (err) { store.appendApplied("o", { at: now(), event: e.id, ok: false, message: errorText(err) }); }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return child;
  };
  return { store, run, set };
}

test("--continued-in goes with the skip as continued_in, and nexus status shows where the step went on", async () => {
  const x = setup();
  assert.match(await x.set("FL", "--step", "FL2", "skipped", "--continued-in", "FL4, FL5", "--reason", "cause found; the fix is FL4 and FL5"),
    /step FL\/FL2 skipped \(was pending\), continued in FL4, FL5/);
  const e = x.store.readEvents("o").entries.find((y) => y.type === "status.set");
  assert.deepEqual(e?.type === "status.set" && e.continued_in, ["FL4", "FL5"]);
  assert.match((await x.run("status")).out, /FL2 skipped → FL4, FL5 \(level 2\)/, "the orchestrator's overview");
  // Without it, a skip is as before; an empty --continued-in is refused before anything is sent.
  assert.match(await x.set("FL", "--step", "FL1", "skipped", "--reason", "no longer needed"), /step FL\/FL1 skipped \(was pending\)$/m);
  assert.match((await x.run("queue", "set", "FL", "--step", "FL3", "skipped", "--continued-in", ",", "--reason", "x")).err, /--continued-in names where/);
});
