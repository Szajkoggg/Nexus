// Templates and recurring queues on the Queues view (src/recurring.ts): the message "New queue from template" sends to
// the orchestrator, the parameters still missing, and how a recurring queue's state, schedule and actions read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filledValues, missingParams, recurringActions, recurringStatus, scheduleWords, templateMessage, type Template } from "../src/recurring.ts";

const BUGFIX: Template = {
  id: "bugfix", title: "Bug fix", layer: "nexus", replaces: [],
  params: [{ name: "issue", description: "what goes wrong" }, { name: "area", description: "where", default: "the engine" }],
};
const CARE: Template = { id: "maintenance", title: "Maintenance", layer: "nexus", replaces: [], maintenance: "survey", params: [{ name: "scope", description: "what", default: "everything" }] };

test("the values sent are those typed, trimmed; an empty one is left to its default; the required ones still empty are named", () => {
  assert.deepEqual(filledValues(BUGFIX, { issue: "  the list crashes ", area: " " }), { issue: "the list crashes" });
  assert.deepEqual(missingParams(BUGFIX, {}), ["issue"]);
  assert.deepEqual(missingParams(BUGFIX, { issue: "  " }), ["issue"]);
  assert.deepEqual(missingParams(BUGFIX, { issue: "x" }), []);
});

test("the orchestrator's message names the template, the values, the defaults left, the command and the user's words", () => {
  const text = templateMessage(BUGFIX, { issue: 'the list "crashes" when empty' }, undefined, "  It started yesterday. ");
  assert.equal(text, [
    "Please draft a queue from template bugfix (Bug fix) with these values:",
    '- issue: the list "crashes" when empty',
    "- area: its default (the engine)",
    'Command: nexus queue draft --template bugfix --set issue="the list \\"crashes\\" when empty"',
    "Also: It started yesterday.",
    "Fill in the rest and upload it for my approval.",
  ].join("\n"));
  // A maintenance template: the mode only when it is not the template's own.
  assert.doesNotMatch(templateMessage(CARE, {}, "survey"), /--maintenance|Maintenance mode/);
  const fix = templateMessage(CARE, { scope: "deps" }, "fix_small");
  assert.match(fix, /^Maintenance mode: fix_small$/m);
  assert.match(fix, /^Command: nexus queue draft --template maintenance --set scope=deps --maintenance fix_small$/m);
});

test("a recurring queue's state, schedule and what the user may do with it", () => {
  assert.deepEqual(recurringStatus({ status: "needs_approval" }), { word: "waits for your approval", tone: "proposed" });
  assert.deepEqual(recurringStatus({ status: "waiting_previous" }), { word: "waits for its previous run", tone: "waiting" });
  assert.equal(scheduleWords({ every: "mon 03:00" }), "every Monday at 03:00");
  assert.equal(scheduleWords({ every: "daily 22:30" }), "every day at 22:30");
  assert.equal(scheduleWords({ every: "monthly 1 09:00" }), "on day 1 of every month at 09:00");
  assert.equal(scheduleWords({ every: "someday" }), "every someday", "another form as it is");
  assert.equal(scheduleWords({ after_queues: 5, counted: 3 }), "after every 5 queues done (3 counted)");
  assert.equal(scheduleWords({ after_queues: 1, counted: 0 }), "after every queue done (0 counted)");
  assert.deepEqual(recurringActions({ status: "needs_approval" }), ["approve", "pause", "remove"]);
  assert.deepEqual(recurringActions({ status: "approved" }), ["pause", "remove"]);
  assert.deepEqual(recurringActions({ status: "paused", paused: true }), ["resume", "remove"]);
});
