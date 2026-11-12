import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAttention, type AttentionItem } from "../src/index.ts";

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
