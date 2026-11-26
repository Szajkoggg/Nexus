// A "Paused for long" waiting card's line (src/paused.ts; queue IWS, docs/ux/idea-work-signals.md part c): the cause,
// how long ago in days, and the step, as the design words them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PausedWarning } from "@nexus/protocol";
import { pausedLine } from "../src/paused.ts";

const SINCE = "2026-11-22T09:00:00.000Z";
const NOW = Date.parse("2026-11-26T10:00:00.000Z");
const w = (o: Partial<PausedWarning>): PausedWarning => ({ cause: "pause", since: SINCE, key: `paused:AD:${SINCE}`, days: 3, title: "Agent digest", ...o });

test("each cause in its words, with the step and how many days ago", () => {
  assert.equal(pausedLine(w({ step: "AD2", step_title: "Summarize", before: true }), NOW), "Paused by you 4 days ago, before step AD2 (Summarize). Nothing runs until you resume it.");
  assert.equal(pausedLine(w({ step: "AD2", step_title: "Summarize" }), NOW), "Paused by you 4 days ago, at step AD2 (Summarize). Nothing runs until you resume it.");
  assert.equal(pausedLine(w({ cause: "stop", step: "AD2" }), NOW), "Stopped by you 4 days ago, at step AD2.");
  assert.equal(pausedLine(w({ cause: "stop_now", step: "AD2" }), NOW), "Stopped at once by you 4 days ago, at step AD2.");
  assert.equal(pausedLine(w({ cause: "restart", step: "AD2" }), NOW), "Paused when the Nexus server restarted, 4 days ago.");
  assert.equal(pausedLine(w({}), Date.parse("2026-11-23T10:00:00.000Z")), "Paused by you 1 day ago. Nothing runs until you resume it.");
});
