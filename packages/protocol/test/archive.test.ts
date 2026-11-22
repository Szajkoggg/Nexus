// Closed queues (queue AQ; docs/design/archive.md): the dashboard's state holds a closed queue that waits for nothing
// as its summary, its details come when it is opened; the model reads no closed queue's logs for the list, the
// statistics or the digest, and lets go of a log no one asked for a while.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectModel, ProjectStore, isArchived, loadProjectState, shownState, statsReport, stepStats, useProjectReaders, type ProjectState,
} from "../src/index.ts";
import { digestInput, projectDigest } from "../src/digest.ts";
import { stateTexts } from "../src/live.ts";
import { generateNexus } from "./synthetic.ts";

// The plain stores here read the files (the test preload would give them models: apps/server/test/model-reads.ts).
useProjectReaders(undefined);
process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-archive-home-"));
const temp = mkdtempSync(join(tmpdir(), "nexus-archive-"));
after(() => rmSync(temp, { recursive: true, force: true }));

let n = 0;
function project(): { files: ProjectStore; model: ProjectModel } {
  const root = join(temp, `p${++n}`);
  generateNexus(root, { scale: 0.1, seed: n });
  const files = ProjectStore.forRoot(root);
  return { files, model: new ProjectModel(files.dir) };
}
const logsHeld = (m: ProjectModel) => m.cache.held().filter((l) => /(activity|chat|refusals)\.jsonl$/.test(l.file));
const closedOf = (s: ProjectState) => s.queues.filter((q) => isArchived(q, s.attention));

test("a closed queue is a summary in the dashboard's state, read without its logs; the same in the list and the statistics", () => {
  const p = project();
  try {
    const full = p.model.current();
    const closed = closedOf(full);
    assert.ok(closed.length > 5 && closed.length < full.queues.length, "the project has closed queues and open ones");
    const shown = shownState(full);
    assert.equal(shownState(full), shown, "the same object for the same state (the live stream compares by identity)");
    for (const q of shown.queues) {
      const whole = full.queues.find((x) => x.id === q.id)!;
      if (!closedOf(full).includes(whole)) { assert.equal(q, whole, `${q.id}: an open queue as it is`); continue; }
      assert.equal(q.archived, true);
      assert.equal(q.description, undefined);
      assert.equal(q.report, undefined);
      for (const st of q.steps) {
        assert.deepEqual([st.timeline, st.messages, st.checks, st.review_items, st.goal, st.summary], [[], [], [], [], "", undefined], `${q.id}/${st.id}: no details`);
      }
      // What the list and its status read stays.
      const listed = (x: typeof q) => ({ id: x.id, title: x.title, status: x.status, run: x.run, updated: x.updated, questions: x.questions,
        steps: x.steps.map((s) => ({ id: s.id, title: s.title, status: s.status, started_at: s.started_at, finished_at: s.finished_at, segments: s.segments, tags: s.tags })) });
      assert.deepEqual(listed(q), listed(whole), `${q.id}: what the list shows`);
    }
    assert.ok(stateTexts(shown)!.size < stateTexts(full)!.size / 2, "the details are most of the state");

    // The statistics are the model's, from the whole state: the same as from the files, and no log was read for them.
    const stats = statsReport(stepStats([full], []), { by: "area" });
    assert.deepEqual(stats, statsReport(stepStats([loadProjectState(p.files)], []), { by: "area" }));
    assert.deepEqual(logsHeld(p.model), [], "no activity, chat or refusals log read for the state, the list or the statistics");

    // Opened: its whole view is the model's; its activity is read when asked, and let go once no one asked for it a while.
    const q = closed[0]!;
    const opened = full.queues.find((x) => x.id === q.id)!;
    assert.ok(opened.steps.some((s) => s.timeline.length > 0), "the opened queue has its timelines");
    const worker = p.files.sessionIds().find((s) => p.files.readSession(s).queue === q.id && p.files.readActivity(s).entries.length)!;
    assert.ok(worker, "a worker of the closed queue with activity");
    assert.deepEqual(p.model.store.readActivity(worker), p.files.readActivity(worker));
    assert.equal(logsHeld(p.model).length, 1);
    assert.equal(p.model.cache.release(Date.now() + p.model.cache.logIdleMs - 1_000), 0, "kept while it was asked for lately");
    assert.equal(p.model.cache.release(Date.now() + p.model.cache.logIdleMs + 1), 1);
    assert.deepEqual(logsHeld(p.model), [], "let go");
    assert.deepEqual(p.model.store.readActivity(worker), p.files.readActivity(worker), "read again from its file when asked");
    const version = p.model.cache.version;
    p.model.cache.release(Date.now() + p.model.cache.logIdleMs + 1);
    assert.equal(p.model.cache.version, version, "letting go is no change of the state");
  } finally { p.model.close(); }
});

test("the digest reads the logs written since its time only, and finds what the whole read finds", () => {
  const p = project();
  try {
    const state = p.model.current();
    // The logs as last written a day ago (the synthetic history's times are older still): a digest of the last hour
    // opens none of them.
    const day = new Date(Date.now() - 86_400_000);
    for (const s of p.files.sessionIds()) for (const log of ["activity", "refusals"]) {
      const f = join(p.files.sessionDir(s), `${log}.jsonl`);
      if (existsSync(f)) utimesSync(f, day, day);
    }
    const input = digestInput(p.model.store, state, new Date(Date.now() - 3_600_000).toISOString());
    assert.deepEqual([input.activity, input.refusals], [[], []]);
    assert.deepEqual(logsHeld(p.model), [], "no log opened for a time after their last write");
    assert.ok(p.files.sessionIds().some((s) => p.files.readActivity(s).entries.length), "there are logs to leave alone");
    // A time before the history: every log is read, and the digest is what reading them all gives.
    const since = "2000-01-01T00:00:00.000Z";
    const all = digestInput(p.model.store, state, since);
    const ids = p.files.sessionIds();
    assert.deepEqual(projectDigest(all, since), projectDigest({
      state,
      events: ids.flatMap((s) => p.files.readEvents(s).entries),
      refusals: ids.flatMap((s) => p.files.readRefusals(s).entries),
      activity: ids.flatMap((s) => p.files.readActivity(s).entries.filter((a) => a.kind === "retry")),
    }, since));
    // A line written now is found by a digest since a moment ago.
    const worker = ids.find((s) => s.startsWith("w-"))!;
    const before = new Date(Date.now() - 1_000).toISOString();
    p.model.store.appendActivity(worker, { at: new Date().toISOString(), kind: "retry", text: "429, again in 30 s" });
    assert.deepEqual(digestInput(p.model.store, state, before).activity.map((a) => a.text), ["429, again in 30 s"]);
  } finally { p.model.close(); }
});
