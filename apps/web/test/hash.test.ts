import { test } from "node:test";
import assert from "node:assert/strict";
import { commitHref, fileHref, hasItem, itemHash, parseHash, projectPart } from "../src/hash.ts";

test("a project's page, a queue and a step, each part encoded", () => {
  assert.equal(itemHash("nexus"), "#/nexus");
  assert.equal(itemHash("nexus", "RX"), "#/nexus/RX");
  assert.equal(itemHash("nexus", "RX", "RX7"), "#/nexus/RX/RX7");
  assert.equal(itemHash("my app", "Q/1", "S#2"), "#/my%20app/Q%2F1/S%232");
  assert.equal(itemHash("nexus", undefined, "RX7"), "#/nexus/RX7", "a step without its queue is no form; the parts present are kept in order");
  assert.equal(itemHash("nexus", "", undefined), "#/nexus", "an empty part is left out");
});

test("a hash read back gives the parts it was built from", () => {
  for (const parts of [["nexus"], ["nexus", "RX"], ["nexus", "RX", "RX7"], ["my app", "Q/1", "S#2"]] as const) {
    const [project, queue, step] = parts;
    assert.deepEqual(parseHash(itemHash(project, queue, step)), { project, queue, step });
  }
  assert.deepEqual(parseHash(""), { project: undefined, queue: undefined, step: undefined });
  assert.deepEqual(parseHash("#/"), { project: undefined, queue: undefined, step: undefined });
  assert.deepEqual(parseHash("#nexus/RX"), { project: "nexus", queue: "RX", step: undefined }, "the slash after # is optional");
  assert.deepEqual(parseHash("#/nexus//RX/"), { project: "nexus", queue: "RX", step: undefined }, "empty parts are skipped");
  assert.deepEqual(parseHash("#/100%/RX"), { project: "100%", queue: "RX", step: undefined }, "a part typed by hand that is no encoding, as it is");
});

test("the drawer is open when a queue is selected; the project's page is the hash without it", () => {
  assert.deepEqual(["#/nexus", "#/nexus/RX", "#/nexus/RX/RX7", "", "#/"].map(hasItem), [false, true, true, false, false]);
  assert.equal(projectPart("#/nexus/RX/RX7"), "#/nexus");
  assert.equal(projectPart("#/my%20app/RX"), "#/my%20app", "as it is written, still encoded");
  assert.equal(projectPart("#/nexus"), "#/nexus");
});

test("links for a new tab: a file at a line, a file, a commit, each over the project's page", () => {
  assert.equal(fileHref("nexus", "docs/DESIGN.md", 12), "?file=docs%2FDESIGN.md&line=12#/nexus");
  assert.equal(fileHref("nexus", "C:\\Code\\a b.ts"), "?file=C%3A%5CCode%5Ca%20b.ts#/nexus");
  assert.equal(commitHref("my app", "4b055ca"), "?commit=4b055ca#/my%20app");
});
