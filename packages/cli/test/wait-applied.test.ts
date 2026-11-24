// The CLI's wait for the server's answer to an orchestrator's request (waitApplied, queue CWA): an answer the server
// writes after the last read but before the deadline passes is the answer, not "the server has not answered yet".
// Measured on the live instance (CWA1): answers came 15-31 s after the request while the server's loop was blocked,
// some of them inside the CLI's last pause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, now } from "@nexus/protocol";
import { waitApplied } from "../src/main.ts";

function store(): ProjectStore {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-wait-applied-"));
  const st = ProjectStore.init(root, { id: "p", name: "P", root });
  st.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: now() });
  return st;
}

test("an answer written during the last pause, after the deadline passed, is read before giving up", async () => {
  const st = store();
  const answer = { at: now(), event: "E1", ok: true, message: "queue Q created" };
  // The first read finds nothing; the server answers while the CLI sleeps past its deadline.
  const sleep = async () => { await new Promise((r) => setTimeout(r, 120)); st.appendApplied("o", answer); };
  const got = await waitApplied(st, "o", "E1", { ms: 60, sleep });
  assert.deepEqual(got && { ok: got.ok, message: got.message }, { ok: true, message: "queue Q created" });
});

test("no answer at all: undefined after the deadline", async () => {
  const st = store();
  const got = await waitApplied(st, "o", "E2", { ms: 60, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  assert.equal(got, undefined);
});
