// The orchestrator's overview (nexus status in its session): a worker session's card gives its size in tokens, so the
// orchestrator can keep to "continue a session only under about 150k tokens" (queue CT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, loadProjectState, now, orchestratorOverview, type SessionFile } from "../src/index.ts";

test("a worker session's card: its context in tokens, with its share of a known window; none known, unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-overview-"));
  process.env.NEXUS_HOME = join(root, "home");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const worker = (id: string, title: string, live?: { context_tokens?: number; context_window?: number }) => {
    const s: SessionFile = { protocol: 1, id, project: "p", role: "worker", runtime: "claude", native_id: null, title, cwd: root, launched_by: "nexus", created_at: now() };
    store.writeSession(s);
    if (live) store.writeRuntime(id, { state: "idle", model: "claude-opus-5-5", turns: 1, updated_at: now(), ...live });
  };
  worker("01SMALL", "small", { context_tokens: 142_300, context_window: 1_000_000 });
  worker("01LARGE", "large", { context_tokens: 204_800, context_window: 256_000 });
  worker("01NOWIN", "no window", { context_tokens: 90_000 });
  worker("01NONE", "never ran");
  const text = orchestratorOverview(loadProjectState(store));
  assert.match(text, /- 01SMALL "small" claude, idle, claude-opus-5-5, context 142\.3k tokens \(14 % of 1M\), free/);
  assert.match(text, /- 01LARGE "large" claude, idle, claude-opus-5-5, context 204\.8k tokens \(80 % of 256k\), free/);
  assert.match(text, /- 01NOWIN "no window" claude, idle, claude-opus-5-5, context 90k tokens, free/);
  assert.match(text, /- 01NONE "never ran" claude, not live, model \?, context unknown, free/);
});
