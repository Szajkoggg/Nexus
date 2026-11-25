import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { errorText, formatIssues } from "../src/errors.ts";

test("errorText: an Error gives its message", () => {
  assert.equal(errorText(new TypeError("Cannot read properties of undefined")), "Cannot read properties of undefined");
});

test("errorText: a thrown string is itself", () => {
  assert.equal(errorText("no such file"), "no such file");
});

test("errorText: undefined and other values are named, never undefined", () => {
  assert.equal(errorText(undefined), "undefined");
  assert.equal(errorText(null), "null");
  assert.equal(errorText(42), "42");
});

test("formatIssues: a schema error's issues as path: message, the whole value as the root given", () => {
  const r = z.object({ a: z.object({ b: z.string() }), n: z.number() }).safeParse({ a: { b: 1 }, n: "x" });
  assert.ok(!r.success);
  assert.match(formatIssues(r.error), /^a\.b: .+; n: .+$/);
  const whole = z.string().safeParse(3);
  assert.ok(!whole.success);
  assert.match(formatIssues(whole.error, "queue"), /^queue: /);
});

test("formatIssues: anything without issues is its errorText", () => {
  assert.equal(formatIssues(new SyntaxError("bad YAML")), "bad YAML");
  assert.equal(formatIssues(undefined), "undefined");
});
