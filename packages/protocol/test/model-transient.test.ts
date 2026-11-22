// A read that fails for a moment (EBUSY, EPERM: another process holds the file on Windows) is not what the file holds
// (queue LH, the LS survey's finding 6): the model neither keeps a log as empty nor a YAML file as a parse error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import YAML from "yaml";
import { FileCache } from "../src/model.ts";

const Line = z.object({ n: z.number() });

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "nexus-transient-"));
  mkdirSync(join(dir, "sessions", "S"), { recursive: true });
  return { dir, cache: new FileCache(dir) };
}

for (const code of ["EBUSY", "EPERM"]) {
  test(`a log read on through a passing ${code}: its lines are kept, and the new ones read (queue LH)`, () => {
    const { dir, cache } = folder();
    const file = join(dir, "sessions", "S", "applied.jsonl");
    writeFileSync(file, `${JSON.stringify({ n: 1 })}\n`);
    try {
      assert.deepEqual(cache.jsonl(file, Line, false).entries, [{ n: 1 }]);
      appendFileSync(file, `${JSON.stringify({ n: 2 })}\n`);
      cache.touched(file);
      const fault = FileCache.faultReads({ file: "sessions/S/applied.jsonl", code });
      try {
        assert.deepEqual(cache.jsonl(file, Line, false).entries.map((e) => e.n), [1, 2], "read once the file is free again, not kept as empty");
        assert.equal(fault.failed(), 1);
      } finally { fault.clear(); }
      assert.equal(cache.resets, 0, "a passing error is no contradiction of the log's position");
    } finally { cache.close(); }
  });
}

test("a log whose reads keep failing: what was read is kept, and read on at the next read once it can (queue LH)", () => {
  const { dir, cache } = folder();
  const file = join(dir, "sessions", "S", "applied.jsonl");
  writeFileSync(file, `${JSON.stringify({ n: 1 })}\n`);
  try {
    cache.jsonl(file, Line, false);
    appendFileSync(file, `${JSON.stringify({ n: 2 })}\n`);
    cache.touched(file);
    const fault = FileCache.faultReads({ file: "sessions/S/applied.jsonl", times: 1000 });
    try { assert.deepEqual(cache.jsonl(file, Line, false).entries.map((e) => e.n), [1], "the lines read before, not none"); }
    finally { fault.clear(); }
    assert.deepEqual(cache.jsonl(file, Line, false).entries.map((e) => e.n), [1, 2], "no touch needed: still to be read");
  } finally { cache.close(); }
});

test("a YAML file read through a passing EBUSY: parsed, not kept as a parse error (queue LH)", () => {
  const { dir, cache } = folder();
  const file = join(dir, "queue.yaml");
  writeFileSync(file, "id: Q\n");
  try {
    const fault = FileCache.faultReads({ file: "queue.yaml", code: "EBUSY" });
    try { assert.deepEqual(cache.parsed(file, YAML.parse), { id: "Q" }); }
    finally { fault.clear(); }
    const always = FileCache.faultReads({ file: "queue.yaml", code: "EPERM", times: 1000 });
    cache.touched(file);
    try { assert.throws(() => cache.parsed(file, YAML.parse), /EPERM/, "still failing: the error, as a read of the file gives"); }
    finally { always.clear(); }
    assert.deepEqual(cache.parsed(file, YAML.parse), { id: "Q" }, "not kept: read again at the next read");
  } finally { cache.close(); }
});
