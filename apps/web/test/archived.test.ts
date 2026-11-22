// A closed queue as the dashboard gets it (queue AQ; docs/design/archive.md): its summary in the project's state shows
// the same in the list (the Finished group, the rail's finished today, the honest status) as its whole view, and
// opening it shows its whole view once read.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectModel, ProjectStore, shownState, type QueueView } from "@nexus/protocol";
import { generateNexus } from "../../../packages/protocol/test/synthetic.ts";
import { splitFinished } from "../src/finished.ts";
import { finishedToday } from "../src/rail.ts";
import { queueStatus } from "../src/queueStatus.ts";
import { detailsPath, openedQueue } from "../src/archived.ts";

process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-archived-home-"));
const temp = mkdtempSync(join(tmpdir(), "nexus-archived-"));
after(() => rmSync(temp, { recursive: true, force: true }));

test("the list shows a closed queue from its summary as from its whole view", () => {
  generateNexus(temp, { scale: 0.1, seed: 7 });
  const model = new ProjectModel(ProjectStore.forRoot(temp).dir);
  try {
    const full = model.current();
    const shown = shownState(full);
    const archived = shown.queues.filter((q) => q.archived);
    assert.ok(archived.length > 5, "closed queues come as summaries");
    const waiting = new Set(full.attention.map((a) => a.queue).filter((x): x is string => !!x));
    const rows = (qs: readonly QueueView[]) => {
      const { active, finished } = splitFinished(qs, waiting);
      return { active: active.map((q) => q.id), finished: finished.map((r) => [r.queue.id, r.queue.title, r.queue.status, r.finished_at, r.ran_ms]) };
    };
    assert.deepEqual(rows(shown.queues), rows(full.queues));
    assert.deepEqual(new Set(rows(shown.queues).finished.map((r) => r[0])), new Set(archived.map((q) => q.id)), "the summaries are the Finished group");
    const lastDay = new Date(Math.max(...full.queues.flatMap((q) => q.steps.map((s) => Date.parse(s.finished_at ?? "") || 0))));
    assert.deepEqual(finishedToday(shown.queues, waiting, lastDay).map((r) => r.queue.id), finishedToday(full.queues, waiting, lastDay).map((r) => r.queue.id));
    for (const q of archived) assert.deepEqual(queueStatus(q), queueStatus(full.queues.find((x) => x.id === q.id)!), `${q.id}: its status`);
  } finally { model.close(); }
});

test("an opened summary shows its whole view once read, never another queue's; an open queue needs no read", () => {
  const summary = { id: "A", archived: true } as QueueView;
  const whole = { id: "A", steps: [] } as unknown as QueueView;
  assert.equal(detailsPath(summary), "/queues/A");
  assert.equal(openedQueue(summary, undefined), undefined, "not shown until read");
  assert.equal(openedQueue(summary, { ...whole, id: "B" }), undefined, "another queue's answer");
  assert.equal(openedQueue(summary, whole), whole);
  const open = { id: "B", steps: [] } as unknown as QueueView;
  assert.equal(detailsPath(open), undefined);
  assert.equal(openedQueue(open, undefined), open);
  assert.equal(detailsPath(undefined), undefined);
});
