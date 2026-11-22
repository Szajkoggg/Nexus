// The page's live stream and its views (queue SD; docs/protocol/live.md, "The dashboard's rules"): a view read once
// applies the messages after where its reply stood and then shows what a full read shows; a message that is not the next
// one (a gap) and a new hello (the socket opened again) make it read in full; a reply from before the socket listened,
// or from another server, is read again; a write's outcome is waited for until the page stands where it left the stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectState } from "@nexus/protocol";
import { diffState } from "@nexus/protocol/live";
import { LiveView, Stream, type Positioned, type ProjectMessage } from "../src/query.ts";
import { activityApplier, applyConversation, applyConversations, applyOrchestrator, applyStateMessage, refusalsApplier } from "../src/liveViews.ts";

const settled = () => new Promise<void>((r) => setImmediate(r));

/** A server as far as the page sees it: its state, its epoch, its sequence; a full read answers what it holds now. */
function server(first: ProjectState) {
  let held = first, seq = 0;
  const epoch = "e1";
  const reads: string[] = [];
  /** The state changed: the message the server sends, with the next number. */
  const change = (next: ProjectState): ProjectMessage => {
    const d = diffState(held, next)!;
    held = next;
    return { type: "state", project: "p", seq: ++seq, ...d };
  };
  const fetcher = (url: string): Promise<Positioned> => { reads.push(url); return Promise.resolve({ body: structuredClone(held), epoch, seq }); };
  /** A change too large for a delta: the server sends a reload. */
  const reload = (): ProjectMessage => ({ type: "state", project: "p", seq: ++seq, reload: true });
  return { change, reload, fetcher, reads, epoch, now: () => held, seq: () => seq };
}

const stateOf = (queues: { id: string; status: string }[], at = "t0") => ({
  project: { id: "p" }, away: null, tags: {}, metrics: {}, attention: [], warnings: [], generated_at: at,
  queues, sessions: [], questions: [], recurring: [],
}) as unknown as ProjectState;

function setup() {
  const s = server(stateOf([{ id: "A", status: "running" }]));
  const stream = new Stream();
  const view = new LiveView<ProjectState>({ url: "/api/projects/p/state", project: "p", stream, fetcher: s.fetcher, apply: applyStateMessage });
  let renders = 0;
  view.subscribe(() => { renders++; });
  return { s, stream, view, renders: () => renders };
}

test("a view applies the messages after its reply and shows what a full read shows", async () => {
  const { s, stream, view } = setup();
  stream.receive({ type: "hello", epoch: s.epoch, projects: { p: 0 } });
  await settled();
  assert.equal(s.reads.length, 2, "read at the start, and again at the hello");
  stream.receive(s.change(stateOf([{ id: "A", status: "review" }], "t1")));
  stream.receive(s.change(stateOf([{ id: "B", status: "approved" }, { id: "A", status: "done" }], "t2")));
  assert.deepEqual(view.view().data, s.now(), "the same as a full read");
  assert.equal(s.reads.length, 2, "and nothing asked again");
});

test("messages that come while the read is on its way are applied after it lands, those it holds are not", async () => {
  const s = server(stateOf([{ id: "A", status: "running" }]));
  const stream = new Stream();
  stream.receive({ type: "hello", epoch: s.epoch, projects: { p: 0 } });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  // The reply is read at seq 1 and lands after the messages 1 and 2 came over the socket.
  const view = new LiveView<ProjectState>({ url: "/state", project: "p", stream, apply: applyStateMessage,
    fetcher: async (url) => { const r = await s.fetcher(url); await held; return r; } });
  view.subscribe(() => {});
  stream.receive(s.change(stateOf([{ id: "A", status: "review" }], "t1")));
  await settled(); // the read is made now, at seq 1 (the server has sent message 1)
  stream.receive(s.change(stateOf([{ id: "A", status: "done" }], "t2")));
  release();
  await settled();
  assert.deepEqual(view.view().data, s.now());
});

test("a reply that lands before the socket brings the messages up to where it stands waits for them, then is fed", async () => {
  const s = server(stateOf([{ id: "A", status: "running" }]));
  const stream = new Stream();
  stream.receive({ type: "hello", epoch: s.epoch, projects: { p: 0 } });
  const late = s.change(stateOf([{ id: "A", status: "review" }], "t1")); // sent, not yet arrived
  const view = new LiveView<ProjectState>({ url: "/state", project: "p", stream, fetcher: s.fetcher, apply: applyStateMessage });
  view.subscribe(() => {});
  await settled();
  stream.receive(late);
  await settled();
  stream.receive(s.change(stateOf([{ id: "A", status: "done" }], "t2")));
  assert.deepEqual(view.view().data, s.now(), "fed after the late message");
});

test("a gap and a new hello make the view read in full; the page is told of the gap", async () => {
  const { s, stream, view } = setup();
  const gaps: string[] = [];
  stream.gap = (p) => gaps.push(p);
  stream.receive({ type: "hello", epoch: s.epoch, projects: { p: 0 } });
  await settled();
  const before = s.reads.length;
  s.change(stateOf([{ id: "A", status: "review" }], "t1")); // message 1 lost on the way
  stream.receive(s.change(stateOf([{ id: "A", status: "done" }], "t2")));
  assert.deepEqual(gaps, ["p"]);
  assert.equal(s.reads.length, before + 1, "the gap is read in full");
  await settled();
  assert.deepEqual(view.view().data, s.now());
  // The socket opened again (perhaps on a new server): its hello reads every view in full.
  stream.receive({ type: "reconnected" });
  stream.receive({ type: "hello", epoch: "e2", projects: { p: 0 } });
  assert.equal(s.reads.length, before + 2);
});

test("a reply from before the socket listened, or from another server, is shown but not fed, and read again at the hello", async () => {
  const s = server(stateOf([{ id: "A", status: "running" }]));
  const stream = new Stream();
  const view = new LiveView<ProjectState>({ url: "/state", project: "p", stream, fetcher: s.fetcher, apply: applyStateMessage });
  view.subscribe(() => {});
  await settled();
  assert.ok(view.view().data, "the first answer shows at once");
  s.change(stateOf([{ id: "A", status: "review" }], "t1"));
  // The socket's hello names seq 1: the reply at 0 missed message 1, sent before the socket listened.
  stream.receive({ type: "hello", epoch: s.epoch, projects: { p: 1 } });
  await settled();
  assert.deepEqual(view.view().data, s.now());
  assert.equal(stream.since("p", "other", 1), undefined, "another server's reply cannot be fed");
  assert.equal(stream.since("p", s.epoch, 0), undefined, "nor one below the hello");
  assert.deepEqual(stream.since("p", s.epoch, 1), []);
});

test("a reload message reads in full; a view nobody shows takes no messages", async () => {
  const { s, stream, view } = setup();
  stream.receive({ type: "hello", epoch: s.epoch, projects: { p: 0 } });
  await settled();
  const before = s.reads.length;
  stream.receive(s.reload());
  assert.equal(s.reads.length, before + 1);
  await settled();
  const off = view.subscribe(() => {});
  off();
  assert.equal(view.active, true, "the first subscriber still shows it");
});

test("a write's outcome: the page waits until it stands where the write left the stream", async () => {
  const stream = new Stream();
  stream.receive({ type: "hello", epoch: "e", projects: { p: 4 } });
  let done = false;
  void stream.reached("p", 6).then(() => { done = true; });
  stream.receive({ type: "log", project: "p", seq: 5, session: "s", log: "activity", entries: [] });
  await settled();
  assert.equal(done, false);
  stream.receive({ type: "log", project: "p", seq: 6, session: "s", log: "activity", entries: [] });
  await settled();
  assert.equal(done, true);
  await stream.reached("p", 3);
  await stream.reached("p", undefined);
});

const log = (session: string, kind: "activity" | "chat" | "refusals" | "pins", body: Record<string, unknown>): ProjectMessage =>
  ({ type: "log", project: "p", seq: 1, session, log: kind, ...body }) as ProjectMessage;

test("a step's activity takes its own lines and keeps the newest; another session's or a reload are not taken", () => {
  const apply = activityApplier<{ text: string; queue?: string; step?: string }>("s1", { queue: "Q", step: "Q1" }, 3);
  const held = [{ text: "a", queue: "Q", step: "Q1" }];
  const lines = [{ text: "b", queue: "Q", step: "Q1" }, { text: "x", queue: "Q", step: "Q2" }, { text: "c", queue: "Q", step: "Q1" }, { text: "d", queue: "Q", step: "Q1" }];
  assert.deepEqual(apply(held, log("s1", "activity", { entries: lines }))?.valueOf(), [{ text: "b", queue: "Q", step: "Q1" }, { text: "c", queue: "Q", step: "Q1" }, { text: "d", queue: "Q", step: "Q1" }]);
  assert.equal(apply(held, log("s2", "activity", { entries: lines })), undefined);
  assert.equal(apply(held, log("s1", "activity", { reload: true })), "reload");
  assert.equal(apply(held, log("s1", "activity", { entries: [{ text: "x", queue: "Q", step: "Q2" }] })), undefined, "nothing of its step: no change");
});

test("the refusals stay oldest first", () => {
  const apply = refusalsApplier<{ at: string }>({});
  assert.deepEqual(apply([{ at: "2" }], log("s", "refusals", { entries: [{ at: "1" }, { at: "3" }] })), [{ at: "1" }, { at: "2" }, { at: "3" }]);
});

test("the chats: lines and pins of their session, the head; the orchestrator's new session reads in full", () => {
  const view = { session: { id: "o1" }, state: "idle", chat: [{ line: 0 }], pins: [] as unknown[] };
  assert.deepEqual(applyOrchestrator(view, log("o1", "chat", { entries: [{ line: 1 }] })), { ...view, chat: [{ line: 0 }, { line: 1 }] });
  assert.deepEqual(applyOrchestrator(view, log("o1", "pins", { pins: [{ line: 0 }] })), { ...view, pins: [{ line: 0 }] });
  assert.equal(applyOrchestrator(view, log("c1", "chat", { entries: [{ line: 1 }] })), undefined);
  const head = (session: string, state: string) => ({ type: "session", project: "p", seq: 1, session, orchestrator: true, head: { session: { id: session }, state } }) as ProjectMessage;
  assert.deepEqual(applyOrchestrator(view, head("o1", "working")), { ...view, state: "working" });
  assert.equal(applyOrchestrator(view, head("o2", "idle")), "reload", "context care switched the session");
  const conv = { ...view, session: { id: "c1" } };
  const own = { type: "session", project: "p", seq: 1, session: "c1", head: { session: { id: "c1" }, state: "working" } } as ProjectMessage;
  assert.deepEqual(applyConversation(conv, own), { ...conv, state: "working" });
  assert.equal(applyConversation(conv, head("o1", "working")), undefined);
});

test("the conversation list: an item replaced or added, the archived last, the latest first", () => {
  const list = [{ id: "a", last_at: "2" }, { id: "b", last_at: "1" }, { id: "z", last_at: "9", archived: true }];
  const item = (id: string, last_at: string) => ({ type: "session", project: "p", seq: 1, session: id, head: {}, conversation: { id, last_at } }) as ProjectMessage;
  assert.deepEqual(applyConversations(list, item("b", "3"))?.valueOf(), [{ id: "b", last_at: "3" }, { id: "a", last_at: "2" }, { id: "z", last_at: "9", archived: true }]);
  assert.deepEqual((applyConversations(list, item("c", "0")) as { id: string }[]).map((c) => c.id), ["a", "b", "c", "z"]);
});
