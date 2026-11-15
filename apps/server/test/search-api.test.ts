// Searching a project's whole history through the API of a real server process (queue SR): a seeded project with
// one item of every kind holding the same word, hits newest first with their places and excerpts, the kind and time
// filters, tool lines only when asked, an answer placed at its question's step; an unknown project is a 404 and a
// search without words a 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, USER_SESSION, newId, writeRegistry, type Event, type SearchResult, type SessionFile } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("the project's history searched: every kind found, filters, tool lines on request; 404 and 400", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-search-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const t = (h: number) => `2026-11-1${h}T10:00:00.000Z`;
  const session = (role: SessionFile["role"], title: string, id = newId()): SessionFile => {
    const s: SessionFile = { protocol: 1, id, project: "p", role, runtime: "external", title, cwd: root, launched_by: "external", created_at: t(0) };
    store.writeSession(s);
    return s;
  };
  const event = (s: SessionFile, e: Record<string, unknown>) => store.appendEvent({ v: 1, id: newId(), session: s.id, ...e } as Event);

  // A queue (title, description, a step's goal), its report and a note on its step.
  store.writeQueue({ protocol: 1, id: "Q", title: "Flood defence", description: "Keep the árvíz out.", steps: [{ id: "Q1", title: "Walls", goal: "Build ÁRVÍZ walls", acceptance: [] }], created_at: t(0), updated_at: t(0) });
  const reportFile = join(store.queueDir("Q"), "report.md");
  writeFileSync(reportFile, "# Report\n\nThe árvíz walls hold.\n");
  // A report's time is its file's.
  const reported = new Date("2026-11-11T12:00:00.000Z");
  utimesSync(reportFile, reported, reported);
  store.writeNote("Q", { id: newId(), step: "Q1", from: "user", at: t(1) }, "Check the árvíz gauge first.");
  // A worker's outcome and question; the user's answer and review comment (in the user's session).
  const worker = session("worker", "Worker");
  const qid = newId();
  event(worker, { at: t(2), type: "step.done", queue: "Q", step: "Q1", summary: "Walls against the árvíz built." });
  event(worker, { at: t(2), type: "step.progress", queue: "Q", step: "Q1", text: "árvíz progress (not searched)" });
  event(worker, { at: t(3), type: "question.asked", queue: "Q", step: "Q1", qid, text: "How high must they be?", can_continue: false });
  const user = session("user", "You (dashboard)", USER_SESSION);
  event(user, { at: t(4), type: "answer.given", qid, text: "Above the 2013 árvíz mark." });
  event(user, { at: t(5), type: "review.commented", queue: "Q", step: "Q1", path: "a.png", text: "The árvíz line is missing.", to: "note" });
  // The orchestrator's chat (a tool line, a broken line) and a thinking partner's.
  const orch = session("orchestrator", "Orchestrator");
  store.appendChat(orch.id, { at: t(6), from: "user", text: "What about the árvíz?" });
  appendFileSync(join(store.sessionDir(orch.id), "chat.jsonl"), "{broken árvíz\n");
  store.appendChat(orch.id, { at: t(7), from: "orchestrator", kind: "tool", text: "Bash: grep árvíz" });
  const partner = session("conversation", "Flood ideas");
  store.appendChat(partner.id, { at: t(8), from: "partner", text: "An árvíz idea." });
  // A worker's chat-like file is not a chat that is searched.
  store.appendChat(worker.id, { at: t(8), from: "partner", text: "árvíz in a worker (not searched)" });

  const port = await freePort();
  const child = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "", NEXUS_CLAUDE: join(here, "fake-claude.ts"), FAKE_LOG: join(base, "fake.log") });
  const api = `http://127.0.0.1:${port}/api/projects`;
  const search = async (query: string, project = "p") => { const r = await fetch(`${api}/${project}/search?${query}`); return { status: r.status, body: await r.json() as SearchResult & { error?: string } }; };
  try {
    await serverUp(api);

    // Every kind, newest first, with its place.
    const all = await search("q=ARVIZ");
    assert.equal(all.status, 200);
    const shape = all.body.hits.map((h) => [h.kind, h.queue ?? h.session, h.step ?? h.line ?? null]);
    assert.deepEqual(shape, [
      ["chat", partner.id, 0],
      ["chat", orch.id, 0],
      ["review", "Q", "Q1"],
      ["question", "Q", "Q1"],
      ["step", "Q", "Q1"],
      ["report", "Q", null],
      ["note", "Q", "Q1"],
      ["queue", "Q", null],
      ["queue", "Q", "Q1"],
    ]);
    assert.equal(all.body.total, 9);
    assert.equal(all.body.more, false);
    // The excerpt and its highlight; titles; the answer placed at its question's step.
    const report = all.body.hits.find((h) => h.kind === "report")!;
    assert.equal(report.excerpt, "# Report The árvíz walls hold.");
    assert.deepEqual(report.ranges.map(([s, e]) => report.excerpt.slice(s, e)), ["árvíz"]);
    assert.equal(report.title, "Flood defence");
    assert.match(report.path!, /\/queues\/Q\/report\.md$/);
    assert.equal(all.body.hits.find((h) => h.kind === "chat" && h.session === partner.id)!.title, "Flood ideas");
    const answer = all.body.hits.find((h) => h.kind === "question")!;
    assert.deepEqual([answer.excerpt, answer.qid, answer.session], ["Above the 2013 árvíz mark.", qid, USER_SESSION]);

    // Several words: every one must occur.
    assert.deepEqual((await search("q=arviz%20walls")).body.hits.map((h) => h.kind), ["step", "report", "queue"]);
    // Kinds, since, limit.
    assert.deepEqual((await search("q=arviz&kinds=chat,note")).body.hits.map((h) => h.kind), ["chat", "chat", "note"]);
    assert.deepEqual((await search(`q=arviz&since=${t(5)}`)).body.hits.map((h) => h.kind), ["chat", "chat", "review"]);
    const two = (await search("q=arviz&limit=2")).body;
    assert.deepEqual([two.hits.length, two.total, two.more], [2, 9, true]);
    // Tool lines only on request; the line is the chat's (the broken line counts).
    assert.deepEqual((await search("q=grep&kinds=chat")).body.hits, []);
    const tool = (await search("q=grep&kinds=chat&tools=1")).body.hits;
    assert.deepEqual(tool.map((h) => [h.session, h.line, h.from]), [[orch.id, 2, "orchestrator"]]);

    // Refused: no words, an unknown kind, a bad time; an unknown project.
    assert.equal((await search("q=%20%20")).status, 400);
    assert.equal((await search("")).status, 400);
    assert.match((await search("q=x&kinds=mail")).body.error!, /kinds/);
    assert.equal((await search("q=x&since=soon")).status, 400);
    assert.equal((await search("q=arviz", "nope")).status, 404);
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.on("exit", r)));
  }
});
