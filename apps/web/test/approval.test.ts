import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEntry } from "@nexus/protocol";
import { draftOf, needsApproval, pinsText, queueReference, runSettings, withReference } from "../src/approval.ts";

const project = {
  defaults: { review_policy: "continue" },
  runtimes: { default: "claude", claude: { effort: "high" }, codex: { model: "gpt-6-luna" } },
} as never;
const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, goal: "", acceptance: [], ...extra });

test("a queue waits for approval while its revision is not approved, unless it is finished or cancelled", () => {
  assert.equal(needsApproval({ approved: false, status: "proposed" }), true);
  assert.equal(needsApproval({ approved: false, status: "stopped" }), true, "a stopped queue's new revision");
  assert.equal(needsApproval({ approved: true, status: "approved" }), false);
  assert.equal(needsApproval({ approved: false, status: "done" }), false);
  assert.equal(needsApproval({ approved: false, status: "cancelled" }), false);
});

test("run settings on one line: steps, where and when, runtime with model and effort, the review policy, own values", () => {
  const r = runSettings({
    steps: [step("SC1"), step("SC2"), step("SC3", { runtime: "codex", model: "gpt-6-luna" }), step("SC4", { effort: "low" })],
    branch: "main", start: { after: "SF" }, review_policy: undefined,
  } as never, project);
  assert.deepEqual(r.parts, ["4 steps", "on main, after SF", "Claude, high", "after each step: go on"]);
  assert.deepEqual(r.own, ["SC3 on Codex · gpt-6-luna", "SC4 on low effort"]);
});

test("run settings: the run's own values first, then its planned start's, then the project's; a worktree; a time", () => {
  const ran = runSettings({ steps: [step("A1")], worktree: "auto", branch: "nexus/A", run: { runtime: "codex", model: "gpt-x", effort: "medium" }, review_policy: "wait" } as never, project);
  assert.deepEqual(ran.parts, ["1 step", "in its own worktree on nexus/A", "Codex, gpt-x, medium", "after each step: wait for my review"]);
  const planned = runSettings({ steps: [], start: { at: "2026-11-13T14:05:00", runtime: "codex" } } as never, project, new Date("2026-11-13T09:00:00"));
  assert.deepEqual(planned.parts, ["0 steps", "at 14:05", "Codex, gpt-6-luna", "after each step: go on"]);
});

const at = (m: number) => `2026-11-13T10:${String(m).padStart(2, "0")}:00Z`;
const entry = (m: number, from: ChatEntry["from"], kind: ChatEntry["kind"], text: string): ChatEntry => ({ at: at(m), from, kind, text });

test("the orchestrator's draft: its last `nexus queue draft` of the queue's file, and the message it wrote after", () => {
  const chat = [
    entry(1, "user", "message", "Plan the Keep or Discard work"),
    entry(2, "orchestrator", "tool", "Write: .nexus/drafts/SC.yaml"),
    entry(3, "orchestrator", "tool", "Bash: nexus queue draft .nexus/drafts/SC.yaml"),
    entry(4, "orchestrator", "message", "SC is drafted: four steps."),
    entry(5, "orchestrator", "tool", "Bash: nexus queue draft .nexus/drafts/SCX.yaml"),
    entry(6, "orchestrator", "message", "SCX too."),
    entry(7, "orchestrator", "tool", "Shell: nexus queue draft .nexus/drafts/SC.yaml"),
    entry(8, "nexus", "message", "applied"),
    entry(9, "orchestrator", "message", "Revision 2 of SC: the dashboard step split in two."),
  ];
  assert.deepEqual(draftOf(chat, "SC"), { at: at(7), message: chat[8] });
  assert.deepEqual(draftOf(chat, "SCX"), { at: at(5), message: chat[5] }, "another queue's file is not this one's");
  assert.equal(draftOf(chat, "S"), undefined, "an id that is only a prefix does not match");
  assert.deepEqual(draftOf(chat.slice(0, 3), "SC"), { at: at(3), message: undefined }, "no message yet while it works");
  assert.equal(draftOf([entry(1, "orchestrator", "tool", "Bash: nexus queue draft -")], "SC"), undefined, "from stdin: unknown");
  assert.equal(draftOf([entry(1, "user", "message", "nexus queue draft .nexus/drafts/SC.yaml")], "SC"), undefined, "only its own tool calls");
});

test("Ask the orchestrator: the reference once at the start of the composer, before what was typed", () => {
  const ref = queueReference("SC", 2);
  assert.equal(ref, "About queue SC (revision 2): ");
  assert.equal(withReference("", ref), ref);
  assert.equal(withReference("  ", ref), ref);
  assert.equal(withReference("why four steps?", ref), `${ref}why four steps?`);
  assert.equal(withReference(`${ref}why?`, ref), `${ref}why?`, "not twice");
});

test("what approving pins, said beside the button", () => {
  assert.equal(pinsText(1, false), "Approving pins revision 1: these steps, their acceptance, the checks and stop conditions");
  assert.equal(pinsText(2, true), "Approving pins revision 2: these steps, their acceptance, the checks and stop conditions; it also lifts the stop");
});
