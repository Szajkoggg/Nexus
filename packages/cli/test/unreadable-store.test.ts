// Store files the CLI reads on the way to something else (queue CHC, step CHC1): an unreadable one is named, never
// taken for a missing one (docs/protocol/cli.md, "Unreadable files"). The review helper's gate, the queue an ask or a
// context summary belongs to, and the role and project `nexus server update` checks. The server commands talk to a
// listener of the test's own, which must get no request: a refusal is the CLI's, before anything is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, newId, writeRegistry, type SessionFile } from "@nexus/protocol";
import { cliRun } from "./run-cli.ts";

const GARBAGE = "{ this is: [not yaml\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-unreadable-cli-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { session: null } });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const session = (role: SessionFile["role"], extra: Partial<SessionFile> = {}): SessionFile => {
    const s: SessionFile = { protocol: 1, id: newId(), project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString(), ...extra };
    store.writeSession(s);
    return s;
  };
  const queue = (id: string) => store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: [{ id: `${id}1`, title: "Build", goal: "Build it.", acceptance: ["Built"] }] });
  const spoil = (file: string) => writeFileSync(file, GARBAGE);
  const sessionFile = (id: string) => join(store.sessionDir(id), "session.yaml");
  const queueFile = (id: string) => join(store.queueDir(id), "queue.yaml");
  return { root, store, session, queue, spoil, sessionFile, queueFile };
}

/** A listener on a free port standing in for the server: it counts the requests it gets, and answers none of them usefully. */
async function listener(): Promise<{ port: number; requests: () => number; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((_req, res) => { n++; res.statusCode = 500; res.end("{}"); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { port: address.port, requests: () => n, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** The environment of a call: no inherited NEXUS_DIR or NEXUS_SESSION, unless given. */
function envOf(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NEXUS_DIR; delete env.NEXUS_SESSION; delete env.NEXUS_PORT;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

test("the review helper's gate refuses a session whose session.yaml cannot be read, naming it; a missing session and a call outside a project pass", async () => {
  const x = setup();
  const broken = x.session("worker");
  x.spoil(x.sessionFile(broken.id));
  const refused = await cliRun(["project", "list"], { cwd: x.root, env: envOf({ NEXUS_DIR: x.store.dir, NEXUS_SESSION: broken.id }) });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /session\.yaml cannot be read/);
  assert.ok(refused.stderr.includes(broken.id), "the file is named by its path");
  // What a helper may run is not refused: nexus help still answers.
  const help = await cliRun(["help", "review"], { cwd: x.root, env: envOf({ NEXUS_DIR: x.store.dir, NEXUS_SESSION: broken.id }) });
  assert.equal(help.status, 0, help.stderr);

  // A NEXUS_SESSION this project has no session for (inherited into a test project, say): the gate lets it through.
  const missing = await cliRun(["project", "list"], { cwd: x.root, env: envOf({ NEXUS_DIR: x.store.dir, NEXUS_SESSION: "no-such-session" }) });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /^p\s/m);

  // Outside any project: nothing to read the session from, and nothing refused.
  const outside = mkdtempSync(join(tmpdir(), "nexus-unreadable-outside-"));
  const out = await cliRun(["project", "list"], { cwd: outside, env: envOf({ NEXUS_SESSION: broken.id }) });
  assert.equal(out.status, 0, out.stderr);
});

test("ask and context name an unreadable queue.yaml met while finding the step's queue; with no queue to find they record none, as before", async () => {
  const x = setup();
  x.queue("Q"); x.queue("B");
  x.spoil(x.queueFile("B"));
  const orch = x.session("orchestrator");
  const env = envOf({ NEXUS_DIR: x.store.dir, NEXUS_SESSION: orch.id });
  const events = () => x.store.readEvents(orch.id).entries.filter((e) => e.type === "question.asked" || e.type === "context.summary");

  for (const args of [["ask", "Which one?", "--step", "Q1"], ["context", "Where it stands.", "--step", "Q1"]]) {
    const r = await cliRun(args, { cwd: x.root, env });
    assert.equal(r.status, 2, `${args[0]}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /queue\.yaml cannot be read/, args[0]);
    assert.ok(r.stderr.includes(join("queues", "B").replace(/\\/g, "/")), `${args[0]} names B's queue.yaml: ${r.stderr}`);
  }
  assert.equal(events().length, 0, "nothing recorded");

  // No step given: no queue to look for, and the question and the summary are recorded without one (today's behaviour).
  assert.equal((await cliRun(["ask", "Which one?"], { cwd: x.root, env })).status, 0);
  assert.equal((await cliRun(["context", "Where it stands."], { cwd: x.root, env })).status, 0);
  assert.deepEqual(events().map((e) => [e.type, e.queue]), [["question.asked", undefined], ["context.summary", undefined]]);
});

test("server update names an unreadable session.yaml or project.yaml, refuses, and sends nothing to the server", async () => {
  const x = setup();
  const l = await listener();
  try {
    const port = String(l.port);
    const broken = x.session("orchestrator");
    x.spoil(x.sessionFile(broken.id));
    const bySession = await cliRun(["server", "update"], { cwd: x.root, env: envOf({ NEXUS_DIR: x.store.dir, NEXUS_SESSION: broken.id, NEXUS_PORT: port }) });
    assert.equal(bySession.status, 2, bySession.stderr);
    assert.match(bySession.stderr, /session\.yaml cannot be read/);
    assert.doesNotMatch(bySession.stderr, /not a session/);

    const orch = x.session("orchestrator");
    x.spoil(x.store.projectFile);
    const byProject = await cliRun(["server", "update"], { cwd: x.root, env: envOf({ NEXUS_DIR: x.store.dir, NEXUS_SESSION: orch.id, NEXUS_PORT: port }) });
    assert.equal(byProject.status, 2, byProject.stderr);
    assert.match(byProject.stderr, /project\.yaml cannot be read/);
    assert.doesNotMatch(byProject.stderr, /not a session/);

    // The user's own shell (no session): --after needs the project, and an unreadable project.yaml is not "no .nexus/".
    const after = await cliRun(["server", "update", "--after", "Q"], { cwd: x.root, env: envOf({ NEXUS_DIR: x.store.dir, NEXUS_PORT: port }) });
    assert.equal(after.status, 2, after.stderr);
    assert.match(after.stderr, /project\.yaml cannot be read/);
    assert.doesNotMatch(after.stderr, /no \.nexus\/ found here/);
    assert.equal(l.requests(), 0, "no request reached the server");
  } finally { await l.close(); }
});
