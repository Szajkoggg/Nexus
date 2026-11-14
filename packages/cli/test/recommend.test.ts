// `nexus ask --recommend` and `nexus answer --escalate --recommend`: the recommendation must name one of the
// question's options (by text or number), is recorded as the option's text, and reaches the user's question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, loadProjectState, type Event } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-recommend-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const now = new Date().toISOString();
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: now, queue: "Q" });
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: now });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: [], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }] });
  const run = (session: string, ...a: string[]) => {
    try {
      return { ok: true, out: execFileSync(process.execPath, [CLI, ...a], { cwd: root, env: { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session }, encoding: "utf8", stdio: "pipe" }) };
    } catch (e) {
      return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) };
    }
  };
  const events = (session: string) => store.readEvents(session).entries as Event[];
  return { store, run, events };
}

test("ask --recommend: by number or text, recorded as the option's text", () => {
  const x = setup();
  assert.ok(x.run("w", "ask", "--step", "Q1", "--option", "Smooth it now", "--option", "Leave it for later", "--recommend", "2", "Smooth the stair?").ok);
  const asked = x.events("w").find((e) => e.type === "question.asked") as Extract<Event, { type: "question.asked" }>;
  assert.equal(asked.recommended, "Leave it for later");
  assert.equal(loadProjectState(x.store).questions[0]!.recommended, "Leave it for later");
  assert.ok(x.run("w", "ask", "--option", "a", "--option", "b", "--recommend", "a", "Which?").ok);
});

test("ask --recommend that is not an option, or without options, is refused and writes nothing", () => {
  const x = setup();
  const bad = x.run("w", "ask", "--option", "a", "--option", "b", "--recommend", "c", "Which?");
  assert.equal(bad.ok, false);
  assert.match(bad.out, /"c" is not one of the options \(1\. a; 2\. b\)/);
  const none = x.run("w", "ask", "--recommend", "1", "Which?");
  assert.equal(none.ok, false);
  assert.match(none.out, /has none/);
  assert.equal(x.events("w").filter((e) => e.type === "question.asked").length, 0);
});

test("answer --escalate --recommend carries the orchestrator's recommendation to the user's question", () => {
  const x = setup();
  x.run("w", "ask", "--option", "now", "--option", "later", "--recommend", "now", "Smooth it?");
  const qid = loadProjectState(x.store).questions[0]!.qid;
  const r = x.run("o", "answer", qid, "A look matter: yours. I recommend later: it keeps W moving.", "--escalate", "--recommend", "later");
  assert.ok(r.ok, r.out);
  const q = loadProjectState(x.store).questions[0]!;
  assert.equal(q.state, "escalated");
  assert.equal(q.recommended, "later");
  assert.equal(loadProjectState(x.store).attention.find((a) => a.qid === qid)?.recommended, "later");
});

test("answer --recommend: only with --escalate, only one of the question's options, only a known question", () => {
  const x = setup();
  x.run("w", "ask", "--option", "now", "--option", "later", "Smooth it?");
  const qid = loadProjectState(x.store).questions[0]!.qid;
  const plain = x.run("o", "answer", qid, "now", "--recommend", "now");
  assert.equal(plain.ok, false);
  assert.match(plain.out, /--recommend goes with --escalate/);
  const bad = x.run("o", "answer", qid, "yours", "--escalate", "--recommend", "3");
  assert.equal(bad.ok, false);
  assert.match(bad.out, /not one of the options/);
  const unknown = x.run("o", "answer", "01XXXXXXXXXXXXXXXXXXXXXXXX", "yours", "--escalate", "--recommend", "1");
  assert.equal(unknown.ok, false);
  assert.match(unknown.out, /no question/);
  assert.equal(x.events("o").length, 0, "nothing written");
});
