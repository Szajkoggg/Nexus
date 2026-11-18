// compareIds: ids compare by code unit, whatever the locale (in hu-HU "ZS" is one letter that sorts after "ZT").
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareIds } from "../src/ids.ts";

test("…ZS sorts before …ZT, as the ULIDs were made; the Hungarian locale would swap them", () => {
  const started = "01JAAAAAAAAAAAAAAAAAAAA0ZS", done = "01JAAAAAAAAAAAAAAAAAAAA0ZT";
  assert.ok(started.localeCompare(done, "hu") > 0, "the hazard: hu-HU puts ZS after ZT");
  assert.deepEqual([done, started].sort(compareIds), [started, done]);
  assert.equal(compareIds(started, done), -1);
  assert.equal(compareIds(done, started), 1);
  assert.equal(compareIds(done, done), 0);
});

test("the other Hungarian digraphs keep their code unit order too", () => {
  const ids = ["CS", "CT", "DZS", "DZT", "GY", "GZ", "NY", "NZ", "TY", "TZ"];
  assert.deepEqual([...ids].reverse().sort(compareIds), ids);
});
