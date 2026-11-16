import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFile, ProjectStore } from "../src/index.ts";

test("cleanup evidence survives a store reload alongside waits and rounds; legacy files remain readable", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-cleanup-protocol-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ProjectStore(dir);
  const legacy = { protocol: 1 as const, steps: {} };
  assert.deepEqual(GitFile.parse(legacy), legacy);
  const record: GitFile = {
    ...legacy,
    cleanup: { waiting: { since: "2026-11-16T12:00:00.000Z", reason: "EPERM" } },
    cleanup_proof: {
      version: 1, at: "2026-11-16T12:00:00.000Z", path: "C:\\temporary\\tree", repository: "C:\\temporary\\repo\\.git",
      repository_identity: "1:9007199254740993:1720000000000000000", branch: "nexus/Q", tip: "a".repeat(40), into: "refs/heads/main",
      entries: [
        { path: "", kind: "directory", identity: "1:9007199254740994:1720000000000000001" },
        { path: "ignored/file.txt", kind: "file", identity: "1:9007199254740995:1720000000000000002", digest: "b".repeat(64), modified: "1720000000000000003:1720000000000000004:33206" },
      ],
    },
  };
  store.writeGit("Q", record);
  assert.deepEqual(new ProjectStore(dir).readGit("Q"), record, "identity and nanosecond fields retain precision in YAML");
  assert.equal(GitFile.safeParse({ ...record, cleanup_proof: { ...record.cleanup_proof, version: 2 } }).success, false);
  assert.equal(GitFile.safeParse({ ...record, cleanup_proof: { ...record.cleanup_proof, tip: undefined } }).success, false);
});
