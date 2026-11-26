// A read that fails for a moment (EBUSY, EPERM: another process holds the file on Windows) is not what the file holds
// (queue LH, the LS survey's finding 6): the model neither keeps a log as empty nor a YAML file as a parse error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import YAML from "yaml";
import { FileCache, ProjectModel } from "../src/model.ts";
import { ProjectStore } from "../src/store.ts";
import { generateNexus } from "./synthetic.ts";

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

test("a log that stays locked costs one wait per derivation: within one, its file is not opened again once refused (queue LCF, LC2 finding 5)", () => {
  // A running worker's events are read on before the state (sync: has it grown?) and in it (readOn), and a log refused
  // for a moment is kept dirty, so each later read of it in the same derivation tried again: each open waits up to
  // 200 ms, synchronously. Counted, not timed: the opens the fault refused (an open tried again within its wait counts
  // once).
  const root = mkdtempSync(join(tmpdir(), "nexus-transient-model-"));
  generateNexus(root, { scale: 0.1, seed: 7 });
  const files = ProjectStore.forRoot(root);
  const worker = files.sessionIds().find((s) => s.startsWith("w-"))!;
  const model = new ProjectModel(files.dir, { volatile: () => [worker] });
  try {
    const before = model.current().sessions.find((s) => s.id === worker)!.event_count;
    const line = { v: 1, id: "TLCF4", at: new Date(Date.UTC(2026, 10, 2)).toISOString(), session: worker, type: "log", level: "info", text: "written while locked" };
    appendFileSync(join(files.sessionDir(worker), "events.jsonl"), JSON.stringify(line) + "\n");
    const fault = FileCache.faultReads({ file: `sessions/${worker}/events.jsonl`, times: 1_000_000 });
    try {
      const locked = model.current();
      assert.equal(fault.failed(), 1, "one derivation: one refused open of the locked log");
      assert.equal(locked.sessions.find((s) => s.id === worker)!.event_count, before, "what was read before is kept");
      assert.notEqual(model.current(), locked, "the state lacked the locked file: the next read derives again");
      assert.equal(fault.failed(), 2, "and tries it once more, once");
    } finally { fault.clear(); }
    assert.equal(model.current().sessions.find((s) => s.id === worker)!.event_count, before + 1, "free again: read on");
  } finally { model.close(); }
});
