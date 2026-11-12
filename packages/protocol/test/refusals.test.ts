// Refused actions: how they group, the allow rule a refusal suggests, and that adding it writes only the project's
// Nexus settings (packages/protocol/src/refusals.ts, addAllowRule in actions.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ActionError, ProjectStore, addAllowRule, commandPrefix, groupRefusals, suggestAllowRule, validAllowRule, type Refusal,
} from "../src/index.ts";

const refusal = (min: number, extra: Partial<Refusal>): Refusal => ({
  at: new Date(Date.UTC(2026, 10, 13, 10, min)).toISOString(), session: "s1", runtime: "claude", by: "permissions",
  tool: "Bash", input: "git push origin main", queue: "Q", step: "Q1", ...extra,
});

test("a command is grouped and allowed by its first words", () => {
  assert.equal(commandPrefix("git push origin main"), "git push");
  assert.equal(commandPrefix("npm run build -w @nexus/web"), "npm run");
  assert.equal(commandPrefix("rm -rf build"), "rm");
  assert.equal(commandPrefix("node scripts/x.js"), "node");
  assert.equal(commandPrefix("  "), "");
});

test("refusals group by tool and command prefix, the most recent group first, with counts", () => {
  const groups = groupRefusals([
    refusal(1, {}), refusal(5, { input: "git push --force" }), refusal(3, { tool: "Write", input: "C:/x/.ssh/config" }),
    refusal(4, { runtime: "codex", by: "auto_review", tool: "command", input: "git push origin main" }),
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.runtime, g.count, g.latest.at.slice(14, 16)]), [
    ["Bash: git push", "claude", 2, "05"], ["command: git push", "codex", 1, "04"], ["Write", "claude", 1, "03"],
  ]);
});

test("a Claude Code refusal suggests a rule in Claude Code's syntax; a Codex one none", () => {
  assert.equal(suggestAllowRule(refusal(0, {})), "Bash(git push:*)");
  assert.equal(suggestAllowRule(refusal(0, { tool: "Write", input: "docs/x.md" })), "Write(docs/x.md)");
  assert.equal(suggestAllowRule(refusal(0, { tool: "WebFetch", input: "https://docs.example.com/a?b" })), "WebFetch(domain:docs.example.com)");
  assert.equal(suggestAllowRule(refusal(0, { tool: "mcp__figma__get_file", input: "{}" })), "mcp__figma__get_file");
  assert.equal(suggestAllowRule(refusal(0, { runtime: "codex", tool: "command" })), undefined);
  assert.ok(validAllowRule("Bash(git push:*)") && validAllowRule("WebFetch") && !validAllowRule("Bash(x)\nWrite") && !validAllowRule("rm -rf /"));
});

/** Every file under a directory with its content, but one. */
function snapshot(dir: string, except: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else if (f !== except) out[relative(dir, f)] = readFileSync(f, "utf8");
    }
  };
  walk(dir);
  return out;
}

test("adding a rule from a refusal changes only the project's Nexus settings", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-allow-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "settings.json"), '{ "permissions": { "allow": ["Read"] } }\n');
  writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
  store.writeSession({ protocol: 1, id: "s1", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString() });
  store.appendRefusal(refusal(1, {}));
  const projectFile = join(store.dir, "project.yaml");
  const before = snapshot(root, projectFile);

  const rule = suggestAllowRule(store.readRefusals("s1").entries[0]!)!;
  assert.deepEqual(addAllowRule(store, ` ${rule} `), { added: true, rule: "Bash(git push:*)" });
  assert.deepEqual(store.readProject().runtimes.claude.allowed_tools, ["Bash(git push:*)"]);
  assert.deepEqual(snapshot(root, projectFile), before, "nothing but .nexus/project.yaml was written");
  assert.deepEqual(addAllowRule(store, rule), { added: false, rule }, "a rule already there is not added twice");
  assert.deepEqual(store.readProject().runtimes.claude.allowed_tools, ["Bash(git push:*)"]);
  assert.throws(() => addAllowRule(store, "Bash(x)\nWrite"), ActionError);
});
