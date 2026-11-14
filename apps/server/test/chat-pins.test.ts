// A chat's lines, older entries, search over the whole chat and pins, through the API of a real server process (the
// fake Claude as the orchestrator's runtime). Decided for CH4: a pin is keyed by the session and the line index in its
// append-only chat.jsonl, stored by the server in sessions/<id>/pins.json; a fresh orchestrator session starts
// without pins; search covers the whole chat, not only what the view sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, newId, writeRegistry, type NumberedEntry, type SessionFile } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

interface View { session: SessionFile | null; chat: NumberedEntry[]; pins: { line: number; at: string; entry: NumberedEntry }[] }

test("pins by line, older entries and search over the whole chat; a fresh orchestrator session starts without pins", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-pins-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  // An orchestrator session with a chat of 320 entries: more than the view's 300, a blank and a broken line among them.
  const orch: SessionFile = { protocol: 1, id: newId(), project: "p", role: "orchestrator", runtime: "claude", native_id: "00000000-0000-4000-8000-0000000000aa", title: "Orchestrator", cwd: root, launched_by: "nexus", created_at: new Date().toISOString() };
  store.writeSession(orch);
  store.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: false, ...p.orchestrator, session: orch.id } }));
  const chatFile = join(store.sessionDir(orch.id), "chat.jsonl");
  const at = "2026-11-14T10:00:00.000Z";
  store.appendChat(orch.id, { at, from: "user", text: "Where is the Kérdés about the stop button?" });
  appendFileSync(chatFile, "\n{broken\n");
  store.appendChat(orch.id, { at, from: "orchestrator", kind: "tool", text: "Bash: nexus status stop" });
  for (let i = 0; i < 318; i++) store.appendChat(orch.id, { at, from: i % 2 ? "orchestrator" : "user", text: `Entry ${i}` });
  store.appendChat(orch.id, { at, from: "orchestrator", text: "The stop button comes in CH4.3." });

  const port = await freePort();
  const child = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "", NEXUS_CLAUDE: join(here, "fake-claude.ts"), FAKE_LOG: join(base, "fake.log") });
  const url = `http://127.0.0.1:${port}/api/projects/p`;
  const page = { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const get = async <T,>(path: string): Promise<{ status: number; body: T }> => { const r = await fetch(url + path); return { status: r.status, body: await r.json() as T }; };
  const post = async (path: string, body: unknown) => { const r = await fetch(url + path, { method: "POST", headers: page, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as { ok?: boolean; error?: string; result?: unknown } }; };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url.replace("/projects/p", "/projects"))).ok) break; } catch { /* not up yet */ } await sleep(100); }

    // The view: the newest 300 entries, each with its line in chat.jsonl (the first entry is line 0; lines 1 and 2 are
    // the blank and the broken one; so the last of 321 entries is line 322).
    let view = (await get<View>("/orchestrator")).body;
    assert.equal(view.chat.length, 300);
    assert.equal(view.chat.at(-1)!.line, 322);
    assert.equal(view.chat.at(-1)!.text, "The stop button comes in CH4.3.");
    assert.deepEqual(view.pins, []);
    const first = view.chat[0]!.line;

    // Older entries: the lines before the view's first, by range.
    const older = (await get<{ chat: NumberedEntry[] }>(`/sessions/${orch.id}/chat?from=0&to=${first}`)).body.chat;
    assert.equal(older.length, 21);
    assert.deepEqual(older.slice(0, 2).map((e) => e.line), [0, 3]);
    assert.equal(older[0]!.text, "Where is the Kérdés about the stop button?");

    // Search covers the whole chat, also what the view did not send; accents and case ignored; tools only when asked.
    assert.deepEqual((await get<{ lines: number[] }>(`/sessions/${orch.id}/chat/search?q=${encodeURIComponent("STOP")}`)).body.lines, [0, 322]);
    assert.deepEqual((await get<{ lines: number[] }>(`/sessions/${orch.id}/chat/search?q=kerdes`)).body.lines, [0]);
    assert.deepEqual((await get<{ lines: number[] }>(`/sessions/${orch.id}/chat/search?q=stop&tools=1`)).body.lines, [0, 3, 322]);
    assert.equal((await get(`/sessions/nope/chat/search?q=x`)).status, 404);

    // Pins: an old message (outside the view) and the newest; the view carries them with their entries.
    assert.equal((await post(`/sessions/${orch.id}/pins`, { line: 0, pinned: true })).status, 200);
    assert.equal((await post(`/sessions/${orch.id}/pins`, { line: 322, pinned: true })).status, 200);
    view = (await get<View>("/orchestrator")).body;
    assert.deepEqual(view.pins.map((p) => [p.line, p.entry.text]), [[0, "Where is the Kérdés about the stop button?"], [322, "The stop button comes in CH4.3."]]);
    const file = join(store.sessionDir(orch.id), "pins.json");
    assert.deepEqual((JSON.parse(readFileSync(file, "utf8")) as { pins: { line: number }[] }).pins.map((p) => p.line), [0, 322]);
    // Refused: a tool line, a line with nothing, a line that is not a number, a write from another page.
    assert.equal((await post(`/sessions/${orch.id}/pins`, { line: 3, pinned: true })).status, 400);
    assert.equal((await post(`/sessions/${orch.id}/pins`, { line: 2, pinned: true })).status, 400);
    assert.equal((await post(`/sessions/${orch.id}/pins`, { line: "0", pinned: true })).status, 400);
    assert.equal((await fetch(url + `/sessions/${orch.id}/pins`, { method: "POST", headers: { ...page, origin: "http://evil.example" }, body: JSON.stringify({ line: 5, pinned: true }) })).status, 403);
    // Unpinning.
    assert.equal((await post(`/sessions/${orch.id}/pins`, { line: 0, pinned: false })).status, 200);
    assert.deepEqual((await get<View>("/orchestrator")).body.pins.map((p) => p.line), [322]);

    // A fresh orchestrator session (New conversation, then a message) starts without pins; the old file stays.
    assert.equal((await post("/orchestrator/reset", {})).status, 200);
    assert.equal((await post("/orchestrator/messages", { text: "Hello again" })).status, 200);
    let fresh: View | undefined;
    for (let i = 0; i < 100 && !(fresh?.session && fresh.session.id !== orch.id); i++) { fresh = (await get<View>("/orchestrator")).body; await sleep(100); }
    assert.ok(fresh?.session && fresh.session.id !== orch.id, "a new orchestrator session");
    assert.deepEqual(fresh!.pins, []);
    assert.equal(fresh!.chat[0]!.line, 0);
    assert.ok(existsSync(file), "the old session's pins stay with it");
    assert.equal((await post(`/sessions/${fresh!.session!.id}/pins`, { line: 0, pinned: true })).status, 200);
    assert.deepEqual((await get<View>("/orchestrator")).body.pins.map((p) => p.entry.text), ["Hello again"]);
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.on("exit", r)));
  }
});
