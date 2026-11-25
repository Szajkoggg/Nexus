import { test } from "node:test";
import assert from "node:assert/strict";
import { errorText } from "../src/errors.ts";

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
