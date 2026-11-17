// The ideas overview over the API (PROTOCOL.md, "Conversations", the ideas overview): GET /api/projects/:id/ideas gives
// the project's notes with each entry's status and history, from a queue that names an entry and a partner's hand-over
// record; an unknown project is 404. A real server process on a free port with a temporary NEXUS_HOME and one made-up
// project; no runtime is started.
import { test } from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, writeRegistry, type Event, type IdeaLinksResponse, type IdeaMatchesResponse, type IdeasResponse, type IdeaStatusesResponse } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { serverUp, untilAsync } from "./wait.ts";

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("status API guards writes, rejects concurrent/stale decisions, watches note changes and survives server restart", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-ideas-status-api-"));
  process.env.NEXUS_HOME = join(base, "home");
  const root = join(base, "p");
  mkdirSync(join(root, "notes"), { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.updateProject((p) => ({ ...p, conversations: { ...p.conversations, notes_dir: "notes" } }));
  const note = join(root, "notes/a.md"), ref = "notes/a.md#2026-11-14";
  const text = "# A\n**Summary:** Summary.\n## Decided\n### 2026-11-14\n- Entire decision.\n## Open\n- Question?\n";
  writeFileSync(note, text);
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  let child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const endpoint = url + "/api/projects/p/ideas/statuses";
  const view = async () => await (await fetch(endpoint)).json() as IdeaStatusesResponse;
  const save = (body: object, origin = url, type = "application/json") => fetch(endpoint, { method: "POST",
    headers: { "content-type": type, origin, "sec-fetch-site": origin === url ? "same-origin" : "cross-site" }, body: JSON.stringify(body) });
  const stop = async () => { if (child.exitCode === null) { const ended = once(child, "exit"); child.kill(); await ended; } };
  try {
    await serverUp(url + "/api/projects");
    const request = { request_id: "drop", revision: (await view()).revision, ref, operation: "drop", reason: "No longer needed" };
    assert.equal((await save(request, "http://evil.example")).status, 403);
    assert.equal((await save(request, url, "text/plain")).status, 415);
    assert.equal((await save({ ...request, reason: " " })).status, 400);
    assert.equal((await save({ ...request, revision: undefined })).status, 400);
    assert.equal((await save({ ...request, ref: "../other/a.md#2026-11-14" })).status, 404);
    const responses = await Promise.all([save(request), save({ ...request, request_id: "competitor" })]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const winner = responses[0]!.status === 200 ? request : { ...request, request_id: "competitor" };
    const saved = await responses.find((r) => r.status === 200)!.json();
    assert.deepEqual(await (await save(winner)).json(), saved);
    assert.equal((await save({ ...winner, reason: "Different" })).status, 409);
    assert.equal((await view()).entries[0]!.disposition, "dropped");
    assert.equal(readFileSync(note, "utf8"), text, "dashboard never writes the note");
    assert.equal((await save({ ...request, request_id: "reopen", revision: (await view()).revision, operation: "reopen" })).status, 200);
    const confirm = { ...request, request_id: "confirm", revision: (await view()).revision, operation: "confirm", evidence_refs: ["release:reviewed-by-user"] };
    assert.equal((await save(confirm)).status, 200);
    assert.equal((await view()).entries[0]!.implementation, "full");
    writeFileSync(note, text.replace("Entire decision", "Changed entire decision"));
    // Poll only the server-owned file: no Ideas GET may be needed to notice this change.
    await untilAsync("watcher persists assessment invalidation", async () => store.readIdeaStatuses().invalidations.length === 1);
    writeFileSync(note, text);
    assert.equal((await save({ ...confirm, request_id: "stale-confirmation" })).status, 409);
    await stop();
    child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
    await serverUp(url + "/api/projects");
    const restored = await view();
    assert.equal(restored.entries[0]!.implementation, "needs_review");
    assert.deepEqual(restored.entries[0]!.stale_reasons, ["Decided content changed"]);
    assert.equal(restored.history.length, 3);
    assert.equal((await save(confirm)).status, 200, "a retry after restart returns the original result without reconfirming");
    assert.equal((await view()).entries[0]!.implementation, "needs_review");
    assert.equal((await save({ ...confirm, request_id: "fresh-confirmation", revision: restored.revision })).status, 200);
    const overview = await (await fetch(url + "/api/projects/p/ideas")).json() as IdeasResponse;
    assert.equal(overview.notes[0]!.implementation, "full");
    assert.equal(overview.notes[0]!.entries[0]!.effective!.implementation, "full");
    assert.equal((await fetch(url + "/api/projects/nope/ideas/statuses")).status, 404);
    assert.deepEqual(store.queueIds(), [], "status actions create no queue or work");
  } finally { await stop(); }
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

    // A save on another edge must not freeze a pending suggestion's evidence.
    store.writeQueue({ ...store.readQueue("OLD"), id: "PENDING", title: "Pending evidence",
      description: "Original context: docs/ideas/plan.md#2026-11-16." });
    await untilAsync("new pending suggestion", async () => (await links()).items.some((r) => r.queue === "PENDING"));
    assert.equal((await save({ request_id: "snapshot-pending", revision: (await links()).revision, operation: "add", queue: "OLD",
      ref: "docs/ideas/plan.md#2026-11-14", reason: "An unrelated edge" })).status, 200);
    const opened = await links();
    const pending = opened.items.find((r) => r.queue === "PENDING")!;
    const decide = { request_id: "stale-evidence", revision: opened.revision, operation: "decide", reason: "Review the suggestion",
      decisions: [{ origin: pending.id, accept: true }] };
    store.writeQueue({ ...store.readQueue("PENDING"), description: "Changed context: docs/ideas/plan.md#2026-11-16." });
    await untilAsync("changed suggestion evidence", async () => (await links()).items.find((r) => r.id === pending.id)!.quote.startsWith("Changed context"));
    assert.equal((await save(decide)).status, 409);
    const refreshed = await links();
    assert.equal(refreshed.items.find((r) => r.id === pending.id)!.recorded_evidence!.quote, pending.quote);
    store.writeQueue({ ...store.readQueue("PENDING"), description: "No note is mentioned now." });
    await untilAsync("removed suggestion reference", async () => (await links()).items.find((r) => r.id === pending.id)!.current_suggestion === null);
    assert.equal((await save({ ...decide, request_id: "removed-evidence", revision: refreshed.revision })).status, 409);
    const historical = (await links()).items.find((r) => r.id === pending.id)!;
    assert.equal(historical.evidence_status, "historical");
    assert.match(historical.diagnostics.join(), /no longer present/);

    const unknown = await get("/api/projects/nope/ideas");
    assert.deepEqual([unknown.status, (unknown.body as { error: string }).error], [404, "unknown project"]);
  } finally {
    child.kill();
  }
});
