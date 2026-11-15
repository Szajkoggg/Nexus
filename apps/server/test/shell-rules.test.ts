// The allow rules for shell commands: every prefix on every shell tool, in one place (queue SH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHELL_TOOLS, shellRules } from "../src/shell-rules.ts";

test("a command prefix becomes a rule on each shell tool, Bash and PowerShell, prefix by prefix", () => {
  assert.deepEqual(SHELL_TOOLS, ["Bash", "PowerShell"]);
  assert.deepEqual(shellRules(["nexus", "git show"]), ["Bash(nexus:*)", "PowerShell(nexus:*)", "Bash(git show:*)", "PowerShell(git show:*)"]);
  assert.deepEqual(shellRules([]), []);
});
