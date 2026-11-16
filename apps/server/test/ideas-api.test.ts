// The ideas overview over the API (PROTOCOL.md, "Conversations", the ideas overview): GET /api/projects/:id/ideas gives
// the project's notes with each entry's status and history, from a queue that names an entry and a partner's hand-over
// record; an unknown project is 404. A real server process on a free port with a temporary NEXUS_HOME and one made-up
// project; no runtime is started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, writeRegistry, type Event, type IdeaLinksResponse, type IdeaMatchesResponse, type IdeasResponse } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp, untilAsync } from "./wait.ts";

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("GET /api/projects/:id/ideas: the notes with their entries' statuses and histories; unknown project 404", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-ideas-api-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "p");
  mkdirSync(join(root, "docs/ideas"), { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "docs/ideas" } }));
  writeFileSync(join(root, "docs/ideas/plan.md"), [
    "# Plan view", "", "**Summary:** The planned order as a graph.", "**Area:** dashboard / queues", "",
    "## Decided", "", "### 2026-11-14", "", "- **The graph.**", "", "### 2026-11-15", "", "- **The layouts.**", "",
    "### 2026-11-16", "", "- **Colours.**", "", "## Open", "", "- Recurring queues once or per run?", "",
  ].join("\n"));
  writeFileSync(join(root, "docs/ideas/README.md"), "# Conventions\n");
  store.writeQueue({
    protocol: 1, id: "PV", title: "The plan view", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "PV1", title: "One", goal: "", acceptance: [] }], source: ["docs/ideas/plan.md#2026-11-14"], created_at: "2026-11-14T18:00:00.000Z",
  });
  approveQueue(store, "PV");
  store.writeSession({ protocol: 1, id: "c", project: "p", role: "conversation", runtime: "claude", cwd: root, launched_by: "nexus", created_at: "2026-11-15T09:00:00.000Z", title: "Layouts" });
  store.appendEvent({ v: 1, id: "e1", at: "2026-11-15T12:40:00.000Z", session: "c", type: "ideas.covered", refs: ["docs/ideas/plan.md#2026-11-15"] } as Event);
  // An earlier queue with no source, whose description names an entry: a suggestion to match.
  store.writeQueue({
    protocol: 1, id: "OLD", title: "Old", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "OLD1", title: "One", goal: "", acceptance: [] }], description: "Decided on 2026-11-16: docs/ideas/plan.md.", created_at: "2026-11-16T18:00:00.000Z",
  });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });

  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  const get = async (path: string) => { const r = await fetch(url + path); return { status: r.status, body: await r.json() as unknown }; };
  try {
    await serverUp(url + "/api/projects");
    const r = await get("/api/projects/p/ideas");
    assert.equal(r.status, 200);
    const ideas = r.body as IdeasResponse;
    assert.equal(ideas.notes_dir, "docs/ideas");
    assert.deepEqual(ideas.notes.map((n) => [n.file, n.title, n.area, n.group, n.status, n.open]), [["docs/ideas/plan.md", "Plan view", "dashboard", "queues", "decided", 1]]);
    const entries = ideas.notes[0]!.entries;
    assert.deepEqual(entries.map((e) => [e.ref, e.status]), [
      ["docs/ideas/plan.md#2026-11-14", "queued"], ["docs/ideas/plan.md#2026-11-15", "handed_over"], ["docs/ideas/plan.md#2026-11-16", "decided"],
    ]);
    assert.deepEqual(entries[0]!.queues.map((q) => [q.id, q.status]), [["PV", "approved"]]);
    assert.deepEqual(entries[0]!.history.map((h) => h.kind), ["decided", "queued", "approved"]);
    assert.deepEqual(entries[1]!.history.map((h) => [h.kind, h.conversation]), [["decided", undefined], ["handed_over", "Layouts"]]);
    assert.deepEqual(ideas.unknown_refs, []);

    assert.deepEqual(ideas.to_match, { suggestions: 1, queues: 1 });

    // The suggestions, and the user's decision on one (a same-origin JSON write, as the dashboard's).
    const matches = (await get("/api/projects/p/ideas/matches")).body as IdeaMatchesResponse;
    assert.deepEqual(matches.items.map((m) => [m.queue, m.ref, m.kind, m.lead]), [["OLD", "docs/ideas/plan.md#2026-11-16", "dated", "Colours"]]);
    const post = async (body: object, origin = url) => fetch(url + "/api/projects/p/ideas/matches", { method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": origin === url ? "same-origin" : "cross-site" }, body: JSON.stringify({ ...body,
      revision: ((await get("/api/projects/p/ideas/matches")).body as IdeaMatchesResponse).revision, request_id: crypto.randomUUID() }) });
    assert.equal((await post({ items: [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-16" }], accept: true }, "http://evil.example")).status, 403, "only the dashboard's own page writes");
    assert.equal((await post({ items: [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], accept: true })).status, 404, "not a suggestion");
    assert.equal((await post({ items: [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-16" }], accept: true })).status, 200);
    const after = (await get("/api/projects/p/ideas")).body as IdeasResponse;
    assert.deepEqual(after.to_match, { suggestions: 0, queues: 0 });
    assert.deepEqual(after.notes[0]!.entries[2]!.queues.map((q) => q.id), ["OLD"], "the accepted match counts as its source");
    assert.equal(after.notes[0]!.entries[2]!.status, "queued", "the queue is not done yet");
    assert.equal(((await get("/api/projects/p/ideas/matches")).body as IdeaMatchesResponse).items[0]!.decision?.accepted, true);

    const links = async () => (await get("/api/projects/p/ideas/links")).body as IdeaLinksResponse;
    const save = (body: object, origin = url, type = "application/json") => fetch(url + "/api/projects/p/ideas/links", {
      method: "POST", headers: { "content-type": type, origin, "sec-fetch-site": origin === url ? "same-origin" : "cross-site" }, body: JSON.stringify(body),
    });
    const before = await links();
    const source = before.items.find((r) => r.origin === "source")!;
    const request = { request_id: "api-correction", revision: before.revision, operation: "correct-source", origin: source.id,
      ref: "docs/ideas/plan.md#2026-11-15", reason: "The source names the wrong date" };
    const queueBefore = readFileSync(join(store.queueDir("PV"), "queue.yaml"), "utf8");
    assert.equal((await save(request, "http://evil.example")).status, 403);
    assert.equal((await save(request, url, "text/plain")).status, 415);
    assert.equal((await save({ ...request, revision: undefined })).status, 400);
    assert.equal((await save({ ...request, ref: "docs/ideas/plan.md#2099-01-01" })).status, 400);
    assert.equal((await save({ ...request, ref: "../other/note.md#2026-11-15" })).status, 400);
    const responses = await Promise.all([save(request), save({ ...request, request_id: "competing-action" })]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409], "one concurrent writer wins; neither silently overwrites");
    const winner = responses[0]!.status === 200 ? request : { ...request, request_id: "competing-action" };
    const result = await responses.find((r) => r.status === 200)!.json() as { result: { id: string } };
    assert.deepEqual(await (await save(winner)).json(), result, "retry returns the saved action");
    assert.equal((await save({ ...winner, reason: "Different request" })).status, 409);
    const changed = await links();
    assert.equal(changed.history.length, before.history.length + 1);
    assert.equal(changed.items.find((r) => r.id === source.id)!.state, "ignored");
    assert.equal(readFileSync(join(store.queueDir("PV"), "queue.yaml"), "utf8"), queueBefore);
    const undo = { request_id: "api-undo", revision: changed.revision, operation: "undo", action: result.result.id, reason: "Restore the previous relationship" };
    assert.equal((await save(undo)).status, 200);
    assert.equal((await links()).items.find((r) => r.id === source.id)!.effective, true);
    assert.equal(new ProjectStore(store.dir).readIdeaMatches().history!.length, before.history.length + 2);
    rmSync(store.queueDir("PV"), { recursive: true });
    await untilAsync("deleted queue diagnostics", async () => (await links()).items.find((r) => r.id === source.id)!.diagnostics.some((d) => d.includes("missing")));
    const missing = await links();
    assert.match(missing.items.find((r) => r.id === source.id)!.diagnostics.join(), /missing/);
    assert.equal((await save({ request_id: "remove-missing", revision: missing.revision, operation: "ignore-source", origin: source.id, reason: "Queue disappeared" })).status, 200);

    const unknown = await get("/api/projects/nope/ideas");
    assert.deepEqual([unknown.status, (unknown.body as { error: string }).error], [404, "unknown project"]);
  } finally {
    child.kill();
  }
});
