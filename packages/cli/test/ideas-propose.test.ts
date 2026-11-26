// `nexus ideas propose` (queue IWS, part d): who may propose idea links, what the CLI checks before it writes, and the
// one ideas.links_proposed event of the session's own it writes; nothing else is written (the server takes it in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, now, type Role } from "@nexus/protocol";
import { cliRun } from "./run-cli.ts";

const REF = "notes/a.md#2026-11-14", OTHER = "notes/a.md#2026-11-15";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-ideas-propose-"));
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "notes/a.md"), "# A\n## Decided\n### 2026-11-14\n- First.\n### 2026-11-15\n- Other.\n");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "notes" } }));
  const queue = (id: string, extra: object = {}) => store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "done",
    steps: [{ id: `${id}1`, title: "Work", goal: "Outcome", acceptance: [], status: "done" }], approvals: [], history: [], checks: [], stop_conditions: [], ...extra });
  queue("A", { source: [REF] });
  queue("B");
  queue("M", { maintenance: "fix_small" });
  const sessions: [string, Role, object][] = [["o", "orchestrator", {}], ["c", "conversation", {}], ["w", "worker", { queue: "B" }], ["m", "worker", { queue: "M" }]];
  for (const [id, role, extra] of sessions) store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: now(), ...extra });
  const nexus = (session: string, ...a: string[]) => cliRun(a, { cwd: root, env: { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session, NEXUS_HOME: join(root, "home") } });
  const proposed = (s: string) => store.readEvents(s).entries.filter((e) => e.type === "ideas.links_proposed");
  return { root, store, nexus, proposed };
}

test("the orchestrator, a thinking partner and a maintenance queue's worker propose; an ordinary worker is refused", async () => {
  const x = setup();
  const r = await x.nexus("o", "ideas", "propose", "add", "--queue", "B", "--ref", "a.md#2026-11-14", "--reason", "B carries it out", "--evidence", "B description: …", "--evidence", "report §2");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^proposed: 1 idea link\(s\), \S+; nothing changes until the user accepts \(Ideas → Manage links\)/);
  const [e] = x.proposed("o");
  assert.deepEqual(e?.type === "ideas.links_proposed" && e.items, [{ op: "add", queue: "B", ref: REF, reason: "B carries it out", evidence: ["B description: …", "report §2"] }], "the notes folder is added");
  // A thinking partner and the maintenance worker each propose another link.
  assert.equal((await x.nexus("c", "ideas", "propose", "remove", "--queue", "A", "--ref", REF, "--reason", "wrong note")).status, 0);
  assert.equal((await x.nexus("m", "ideas", "propose", "replace", "--queue", "A", "--ref", REF, "--to", OTHER, "--reason", "wrong date")).status, 0);
  const w = await x.nexus("w", "ideas", "propose", "add", "--queue", "B", "--ref", OTHER, "--reason", "r");
  assert.equal(w.status, 2);
  assert.match(w.stderr, /only the orchestrator, a thinking partner or a worker of a maintenance queue may propose idea links/);
  assert.equal(x.proposed("w").length, 0);
  assert.equal(existsSync(join(x.store.dir, "idea-proposals.yaml")), false, "the CLI never writes the proposals file");
  assert.equal(existsSync(join(x.store.dir, "idea-matches.yaml")), false, "nor a link");
});

test("what the CLI refuses before it writes: an unknown queue or entry, a link that exists already or no longer, replace without --to", async () => {
  const x = setup();
  const cases: [string[], RegExp][] = [
    [["add", "--queue", "Z", "--ref", REF], /queue Z does not exist/],
    [["add", "--queue", "B", "--ref", "notes/a.md#2026-11-20"], /has no Decided entry of 2026-11-20/],
    [["add", "--queue", "A", "--ref", REF], /this link already exists \(the queue's source\)/],
    [["remove", "--queue", "B", "--ref", REF], /this link no longer exists/],
    [["replace", "--queue", "A", "--ref", REF], /replace, and only replace, names --to/],
    [["link", "--queue", "A", "--ref", REF], /nexus ideas propose add\|remove\|replace/],
  ];
  for (const [a, what] of cases) {
    const r = await x.nexus("o", "ideas", "propose", ...a, "--reason", "r");
    assert.equal(r.status, 2, `${a.join(" ")}: ${r.stdout}`);
    assert.match(r.stderr, what);
  }
  assert.equal(x.proposed("o").length, 0, "nothing proposed");
});

test("a batch from a file is one event with the batch's reason; one bad item refuses the whole batch", async () => {
  const x = setup();
  const file = join(x.root, "proposals.yaml");
  writeFileSync(file, `reason: From the notes survey's report\nitems:\n  - { op: add, queue: B, ref: a.md#2026-11-14, reason: B carries it out }\n  - { op: replace, queue: A, ref: ${REF}, to: ${OTHER}, reason: wrong date, evidence: [A description] }\n`);
  const r = await x.nexus("o", "ideas", "propose", "--file", file);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^proposed: 2 idea link\(s\)/);
  const [e] = x.proposed("o");
  assert.equal(e?.type === "ideas.links_proposed" && e.reason, "From the notes survey's report");
  assert.equal(e?.type === "ideas.links_proposed" && e.items.length, 2);
  writeFileSync(file, `- { op: add, queue: M, ref: ${OTHER}, reason: r }\n- { op: add, queue: Z, ref: ${OTHER}, reason: r }\n`);
  const bad = await x.nexus("o", "ideas", "propose", "--file", file);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /nothing proposed: add Z notes\/a.md#2026-11-15: queue Z does not exist/);
  assert.equal(x.proposed("o").length, 1);
});
