// The ideas overview over the API (PROTOCOL.md, "Conversations", the ideas overview): GET /api/projects/:id/ideas gives
// the project's notes with each entry's status and history, from a queue that names an entry and a partner's hand-over
// record; an unknown project is 404. A real server process on a free port with a temporary NEXUS_HOME and one made-up
// project; no runtime is started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, writeRegistry, type Event, type IdeaMatchesResponse, type IdeasResponse } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp } from "./wait.ts";

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
    const post = (body: unknown, origin = url) => fetch(url + "/api/projects/p/ideas/matches", { method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": origin === url ? "same-origin" : "cross-site" }, body: JSON.stringify(body) });
    assert.equal((await post({ items: [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-16" }], accept: true }, "http://evil.example")).status, 403, "only the dashboard's own page writes");
    assert.equal((await post({ items: [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-14" }], accept: true })).status, 404, "not a suggestion");
    assert.equal((await post({ items: [{ queue: "OLD", ref: "docs/ideas/plan.md#2026-11-16" }], accept: true })).status, 200);
    const after = (await get("/api/projects/p/ideas")).body as IdeasResponse;
    assert.deepEqual(after.to_match, { suggestions: 0, queues: 0 });
    assert.deepEqual(after.notes[0]!.entries[2]!.queues.map((q) => q.id), ["OLD"], "the accepted match counts as its source");
    assert.equal(after.notes[0]!.entries[2]!.status, "queued", "the queue is not done yet");
    assert.equal(((await get("/api/projects/p/ideas/matches")).body as IdeaMatchesResponse).items[0]!.decision?.accepted, true);

    const unknown = await get("/api/projects/nope/ideas");
    assert.deepEqual([unknown.status, (unknown.body as { error: string }).error], [404, "unknown project"]);
  } finally {
    child.kill();
  }
});
