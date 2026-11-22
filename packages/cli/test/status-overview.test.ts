// An orchestrator's `nexus status` (queue ND): short by default (the open queues, the finished ones counted, the live
// worker sessions, those of open queues and the 10 latest others with cards cut short), everything with --all (what a
// fresh orchestrator session starts from), one queue with --queue; Waiting for the user and the machine in each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, newId, orchestratorOverview, orchestratorStatusChange, writeCapacity, type Event } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");
const T0 = Date.now() - 86_400_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const LONG = `${"what this session knows ".repeat(20)}END`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-status-overview-"));
  const home = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const session = (id: string, role: "worker" | "orchestrator", queue?: string) =>
    store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: at(0), ...(queue ? { queue } : {}) });
  const emit = (min: number, session: string, body: Record<string, unknown>) => store.appendEvent({ v: 1, id: newId(), at: at(min), session, ...body } as Event);
  for (const id of ["O", "S", "F"]) {
    store.writeQueue({ protocol: 1, id, title: `Queue ${id}`, revision: 1, status: "proposed", stop_conditions: [], checks: [],
      steps: [{ id: `${id}1`, title: `Step ${id}1`, goal: "", acceptance: [] }] });
    approveQueue(store, id);
  }
  session("o", "orchestrator");
  // 14 free sessions without a queue (w01 oldest), one of the open queue O, one of S, one of the finished queue F.
  const workers = [...Array.from({ length: 14 }, (_, i) => `w${String(i + 1).padStart(2, "0")}`), "a-O", "a-S", "a-F"];
  for (const id of workers) {
    session(id, "worker", id.startsWith("a-") ? id.slice(2) : undefined);
    emit(1, id, { type: "context.summary", text: `${id}: ${LONG}`, topics: ["t"], files: [] });
  }
  // S stops: it waits for the user. F is cancelled: finished.
  emit(2, "a-S", { type: "step.started", queue: "S", step: "S1" });
  emit(3, "a-S", { type: "queue.stop", queue: "S", step: "S1", condition: "art", reason: "missing" });
  orchestratorStatusChange(store, { queue: "F", to: "cancelled", reason: "no longer needed" });
  process.env.NEXUS_HOME = home;
  writeCapacity({ protocol: 1, workstation: "WS", slots: { heavy: 1 }, waiting: [],
    held: [{ id: "c1", kind: "checks", project: "p", queue: "O", step: "O1", requested_at: at(4), granted_at: at(4) }], updated_at: at(4) });
  const status = (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_HOME: home };
    delete env.NEXUS_SESSION;
    return execFileSync(process.execPath, [CLI, "status", "--session", "o", ...args], { env, encoding: "utf8" });
  };
  return { store, workers, status };
}

const sessions = (out: string) => [...out.matchAll(/^- (\S+) "/gm)].map((m) => m[1]);
const MACHINE = /^machine WS \(one heavy operation at a time, across projects\):\n {2}running: checks of O\/O1 \(project p\)/m;
const WAITING = /^Waiting for the user\n- stopped S[^\n]*: art: missing$/m;

test("the short overview: open queues, finished ones counted, the live, open queues' and 10 latest sessions with short cards", () => {
  const { status } = setup();
  const out = status();
  assert.match(out, /^Queues \(2 open; finished: 1; nexus status --all names them\)$/m);
  assert.match(out, /^- O \[approved\] Queue O/m);
  assert.match(out, /^- S \[stopped\] Queue S/m);
  assert.doesNotMatch(out, /^- F /m);
  assert.deepEqual(sessions(out), ["a-O", "a-S", "w05", "w06", "w07", "w08", "w09", "w10", "w11", "w12", "w13", "w14"]);
  assert.match(out, /^Worker sessions \(17; shown: the 12 live, of open queues and latest, cards cut to 300 characters; nexus status --all shows every one whole\)$/m);
  const cards = out.split("\n").filter((l) => l.startsWith("  knows: "));
  assert.equal(cards.length, 12);
  for (const c of cards) assert.ok(c.length <= 300 && c.endsWith("…"), c);
  assert.match(out, WAITING);
  assert.match(out, MACHINE);
});

test("--all: every queue and session with whole cards, as a fresh orchestrator session gets it; --queue: one queue", () => {
  const { store, workers, status } = setup();
  const all = status("--all");
  assert.match(all, /^Queues \(2 open; finished: F\)$/m);
  assert.deepEqual(sessions(all), [...workers].sort());
  const cards = all.split("\n").filter((l) => l.startsWith("  knows: "));
  assert.equal(cards.length, workers.length);
  // Whole: a card text longer than 300 characters shows to its end (LONG ends in END).
  assert.ok(LONG.length > 300);
  for (const c of cards) assert.ok(c.length > 300 && c.endsWith(" END") && !c.includes("…"), `a whole card: ${c}`);
  assert.ok(all.startsWith(`project P (p)\n${orchestratorOverview(loadProjectState(store))}\n\nmachine WS`), "the overview the server seeds a fresh session with, then the machine");
  assert.match(all, WAITING);
  assert.match(all, MACHINE);

  const one = status("--queue", "S");
  assert.match(one, /^Queues \(1 open; finished: none\)\n- S \[stopped\] Queue S/m);
  assert.doesNotMatch(one, /^- O /m);
  assert.deepEqual(sessions(one), ["a-S"]);
  assert.match(one, /^Worker sessions \(1 of queue S\)$/m);
  assert.match(one, WAITING);
  assert.match(one, MACHINE);
  const finished = status("--queue", "F");
  assert.match(finished, /^- F \[cancelled\] Queue F/m, "a finished queue by name");
  assert.deepEqual(sessions(finished), ["a-F"]);
  assert.doesNotMatch(finished, /^Waiting for the user/m, "nothing waits about F");
  assert.throws(() => status("--queue", "NOPE"), /unknown queue NOPE/);
});
