// The settings form's refusals (src/settingsCheck.ts): an empty stop condition and a send-back limit below zero (or not
// a whole number) cannot be saved; only the settings being saved are looked at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIX_LIMIT, SEND_BACKS, STOPS, conditionList, savedConditions, settingsProblem } from "../src/settingsCheck.ts";

const keys = [STOPS, SEND_BACKS];

test("a list of filled conditions and a limit of zero or more can be saved; none at all too", () => {
  assert.equal(settingsProblem({ [STOPS]: ["Never touch production.", "Stop before a schema change."], [SEND_BACKS]: 3 }, keys), undefined);
  assert.equal(settingsProblem({ [STOPS]: [], [SEND_BACKS]: 0 }, keys), undefined, "no conditions, no send-backs");
});

test("an empty or blank condition is refused, named by its place", () => {
  assert.deepEqual(settingsProblem({ [STOPS]: ["One.", ""], [SEND_BACKS]: 2 }, keys), { kind: "emptyCondition", n: 2 });
  assert.deepEqual(settingsProblem({ [STOPS]: ["   ", "Two."], [SEND_BACKS]: 2 }, keys), { kind: "emptyCondition", n: 1 });
});

test("a negative, fractional or missing limit is refused", () => {
  for (const n of [-1, 1.5, "", undefined, Number.NaN]) assert.deepEqual(settingsProblem({ [STOPS]: [], [SEND_BACKS]: n }, keys), { kind: "badLimit" }, String(n));
});

test("only the settings being saved are looked at (a following setting is not the project's to save)", () => {
  assert.equal(settingsProblem({ [STOPS]: [""], [SEND_BACKS]: -1 }, ["defaults.review_level"]), undefined);
  assert.deepEqual(settingsProblem({ [STOPS]: [""], [SEND_BACKS]: -1 }, [SEND_BACKS]), { kind: "badLimit" });
});

test("the list as held and as saved: texts, trimmed on save", () => {
  assert.deepEqual(conditionList(undefined), []);
  assert.deepEqual(savedConditions(["  Stop before a schema change. "]), ["Stop before a schema change."]);
});

test("the check-fix limit (queue EF): a whole number of zero or more is saved; anything else is refused with its own text", () => {
  assert.equal(settingsProblem({ [FIX_LIMIT]: 0 }, [FIX_LIMIT]), undefined);
  assert.equal(settingsProblem({ [FIX_LIMIT]: 5 }, [FIX_LIMIT]), undefined);
  for (const n of [-1, 1.5, "", undefined]) assert.deepEqual(settingsProblem({ [FIX_LIMIT]: n }, [FIX_LIMIT]), { kind: "badFixLimit" }, String(n));
  assert.equal(settingsProblem({ [FIX_LIMIT]: -1 }, ["defaults.review_level"]), undefined, "a following limit is not the project's to save");
});
