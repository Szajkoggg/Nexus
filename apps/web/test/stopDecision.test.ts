import { test } from "node:test";
import assert from "node:assert/strict";
import { needsWorkChoice, stopDecision, type LeftView } from "../src/stopDecision.ts";

const commit = (sha: string) => ({ sha, subject: `commit ${sha}`, author: "Worker", at: "2026-11-13T10:00:00Z", files: 1, insertions: 3, deletions: 0 });
const left = (commits: number, extra: Partial<LeftView> = {}): LeftView => ({
  step: "W4c", commits: Array.from({ length: commits }, (_, i) => commit(`c${i}`)), uncommitted: [], uncommitted_note: "in the checkout", discarded: null, ...extra,
});
const LIFTS = "Lifts the stop; the stopped step runs again in its session, unless it was skipped.";

test("a choice is needed only when the step left commits of its own and Discard is not recorded", () => {
  assert.equal(needsWorkChoice(left(2)), true);
  assert.equal(needsWorkChoice(left(0)), false);
  assert.equal(needsWorkChoice(left(0, { uncommitted: [{ status: "M", path: "a.ts" }] })), false, "uncommitted changes are shown, never asked about");
  assert.equal(needsWorkChoice(left(2, { discarded: { at: "2026-11-13T11:00:00Z" } })), false);
  assert.equal(needsWorkChoice(null), false, "outside git");
  assert.equal(needsWorkChoice(undefined), false);
  assert.equal(needsWorkChoice("error"), false);
});

test("approved, nothing left: Continue lifts the stop at once", () => {
  const d = stopDecision({ approved: true, revision: 1, left: left(0) });
  assert.equal(d.needsChoice, false);
  assert.deepEqual(d.opener && [d.opener.action, d.opener.label, d.opener.disabled], ["continue", "Continue", false]);
  assert.deepEqual(d.confirm, { label: "Continue", disabled: false });
  assert.equal(d.hint, LIFTS);
  assert.equal(d.approve, undefined);
  // Outside git the same: nothing to decide.
  assert.deepEqual(stopDecision({ approved: true, revision: 1, left: null }).opener?.action, "continue");
});

test("approved, the step left commits: Continue… opens the choice; the confirm button follows Keep or Discard", () => {
  const none = stopDecision({ approved: true, revision: 1, left: left(2) });
  assert.equal(none.needsChoice, true);
  assert.deepEqual(none.opener && [none.opener.action, none.opener.label, none.opener.title], ["choose", "Continue…", "Step W4c left 2 commits: keep or discard them first"]);
  assert.deepEqual(none.confirm, { label: "Continue", disabled: true });
  assert.equal(none.hint, "Choose Keep or Discard first.");

  const keep = stopDecision({ approved: true, revision: 1, left: left(1), work: "keep" });
  assert.equal(keep.opener?.title, "Step W4c left 1 commit: keep or discard them first");
  assert.deepEqual(keep.confirm, { label: "Continue", disabled: false });
  assert.equal(keep.hint, LIFTS);

  const discard = stopDecision({ approved: true, revision: 1, left: left(2), work: "discard" });
  assert.deepEqual(discard.confirm, { label: "Discard and ask for a revert", disabled: false });
  assert.equal(discard.hint, "The stop stays until you approve the orchestrator's revert.");
});

test("while what the step left is read, Continue waits; when it cannot be read, Continue is offered and the server asks", () => {
  const reading = stopDecision({ approved: true, revision: 1, left: undefined });
  assert.deepEqual(reading.opener && [reading.opener.label, reading.opener.disabled], ["Continue", true]);
  assert.equal(reading.confirm?.disabled, true);
  const unreadable = stopDecision({ approved: true, revision: 1, left: "error" });
  assert.deepEqual(unreadable.opener && [unreadable.opener.action, unreadable.opener.disabled], ["continue", false]);
  assert.equal(unreadable.needsChoice, false);
});

test("Discard recorded: no Continue anywhere; the hint says approving the revert lifts the stop", () => {
  const d = stopDecision({ approved: true, revision: 1, left: left(2, { discarded: { at: "2026-11-13T11:00:00Z" } }) });
  assert.equal(d.discarded, true);
  assert.equal(d.needsChoice, false);
  assert.equal(d.opener, undefined);
  assert.equal(d.confirm, undefined);
  assert.equal(d.hint, "You chose to discard step W4c's commits: the orchestrator proposes a revision that reverts them, and approving it lifts the stop.");
});

test("a revision not approved: Approve revision N… opens the queue; the approval's button follows Discard", () => {
  const d = stopDecision({ approved: false, revision: 2, left: left(2) });
  assert.deepEqual(d.opener && [d.opener.action, d.opener.label], ["open", "Approve revision 2…"]);
  assert.equal(d.confirm, undefined, "Continue is not offered: approving lifts the stop");
  assert.deepEqual(d.approve, { label: "Approve revision 2", disabled: true, hint: "First choose Keep or Discard for step W4c's commits, in the stop box." });
  assert.deepEqual(stopDecision({ approved: false, revision: 2, left: left(2), work: "keep" }).approve,
    { label: "Approve revision 2", disabled: false, hint: "With Keep: step W4c's commits stay, and approving revision 2 lifts the stop." });
  assert.deepEqual(stopDecision({ approved: false, revision: 2, left: left(2), work: "discard" }).approve,
    { label: "Discard the step's work", disabled: false, hint: "With Discard nothing is approved now: the orchestrator proposes a revision that reverts step W4c's commits." });
  // Without commits of its own Discard means nothing: the plain approval, with nothing to add to what it pins.
  assert.deepEqual(stopDecision({ approved: false, revision: 2, left: left(0), work: "discard" }).approve, { label: "Approve revision 2", disabled: false, hint: undefined });
  // Discard recorded: approving the revert lifts the stop without asking again.
  assert.deepEqual(stopDecision({ approved: false, revision: 3, left: left(2, { discarded: { at: "2026-11-13T11:00:00Z" } }) }).approve,
    { label: "Approve revision 3", disabled: false, hint: "You chose to discard step W4c's work: approving revision 3 lifts the stop." });
  // Not yet read: the queue opens all the same.
  assert.equal(stopDecision({ approved: false, revision: 2, left: undefined }).opener?.disabled, false);
});
