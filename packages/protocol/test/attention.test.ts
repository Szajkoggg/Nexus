import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionKey, mergeAttention, type AttentionItem } from "../src/index.ts";

const item = (kind: AttentionItem["kind"], queue: string, at?: string, step?: string): AttentionItem => ({ kind, queue, step, text: `${kind} ${queue}`, at });

test("items of all projects in one list, newest first, each with its project", () => {
  const merged = mergeAttention([
    { id: "a", name: "Alpha", attention: [item("question", "Q", "2026-11-12T10:05:00Z", "Q2"), item("approval", "R", "2026-11-11T09:00:00Z")] },
    { id: "b", name: "Beta", attention: [item("stopped", "S", "2026-11-12T11:00:00Z"), item("failed", "T", "2026-11-12T08:00:00.500Z", "T1")] },
    { id: "c", name: "Empty", attention: [] },
  ]);
  assert.deepEqual(merged.map((m) => `${m.project}:${m.kind}:${m.queue}`), ["b:stopped:S", "a:question:Q", "b:failed:T", "a:approval:R"]);
  assert.equal(merged[1]!.project_name, "Alpha");
  assert.equal(merged[1]!.step, "Q2");
});

test("times written differently compare as times; items without a time go last; ties keep the order", () => {
  const merged = mergeAttention([
    { id: "a", name: "A", attention: [item("review", "X"), item("review", "Y", "2026-11-12T10:00:00Z")] },
    { id: "b", name: "B", attention: [item("review", "Z", "2026-11-12T11:00:00+02:00"), item("review", "W", "2026-11-12T10:00:00.000Z")] },
  ]);
  // 11:00+02:00 is 09:00Z: older than 10:00Z.
  assert.deepEqual(merged.map((m) => m.queue), ["Y", "W", "Z", "X"]);
  assert.deepEqual(mergeAttention([]), []);
});

test("every waiting item has a key of its own, and the same item keeps its key", () => {
  const at = "2026-11-15T10:00:00Z";
  const recurring = (id: string, t = at): AttentionItem => ({ kind: "recurring", recurring: id, approvable: true, text: `Recurring ${id} waits`, at: t });
  const held = (predecessor: string): AttentionItem => ({ kind: "plan", queue: "Q", text: "Q waits", at, plan: { predecessor, cause: "stopped" } });
  const items = [recurring("r1"), recurring("r2"), recurring("r3"), held("A"), held("B"),
    { kind: "plan", queue: "Q", text: "a proposal", at, plan: { proposal: { after: ["A"], reason: "", current: [] } } },
    { kind: "tags", text: "a tag", at, tags: { id: "t1" } as AttentionItem["tags"] }, { kind: "tags", text: "a tag", at, tags: { id: "t2" } as AttentionItem["tags"] },
    item("approval", "Q", at, "Q1"), item("approval", "Q", at, "Q2"), item("stopped", "Q", at)] satisfies AttentionItem[];
  const keys = items.map(attentionKey);
  assert.equal(new Set(keys).size, keys.length, keys.join(" | "));
  // The same item, as the next read of the project gives it, keeps its key (the list keeps its element).
  assert.equal(attentionKey({ ...recurring("r1") }), attentionKey(recurring("r1")));
  assert.equal(attentionKey(held("A")), attentionKey({ ...held("A"), text: "Q waits, but A stopped" }));
  // A recurring item at a new time is news again; a stopped queue stays one item whatever its step.
  assert.notEqual(attentionKey(recurring("r1", "2026-11-16T10:00:00Z")), attentionKey(recurring("r1")));
  const stopped = { kind: "stopped", queue: "Q", text: "stopped", lift: { place: "", continue: true, revision: 1 } } satisfies AttentionItem;
  assert.equal(attentionKey({ ...stopped, step: "Q1" }), attentionKey({ ...stopped, step: "Q2" }));
});
