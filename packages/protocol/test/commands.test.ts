// Only a command can be a check (queue EF, P1; src/commands.ts): a draft whose check is no command is refused with
// where its text belongs; a command, a script in the repository or a program on the PATH is taken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { ActionError, ProjectStore, applyDraft, checkCommandIssue, commandWord, isCommand } from "../src/index.ts";

const win = process.platform === "win32";

/** A repository with a script, and a PATH with one program, `az`, beside Node's own folder. */
function place() {
  const root = mkdtempSync(join(tmpdir(), "nexus-commands-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "check.sh"), "exit 0\n");
  writeFileSync(join(root, "gradlew"), "exit 0\n");
  const bin = mkdtempSync(join(tmpdir(), "nexus-commands-bin-"));
  writeFileSync(join(bin, win ? "az.cmd" : "az"), "exit 0\n", { mode: 0o755 });
  const env = { PATH: [bin, dirname(process.execPath)].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  return { root, env };
}

test("the first word of a check: assignments skipped, quotes taken off", () => {
  assert.equal(commandWord("npm run lint"), "npm");
  assert.equal(commandWord("  CI=1 FOO=bar npm test"), "npm");
  assert.equal(commandWord(`"C:/Program Files/nodejs/node.exe" x.js`), "C:/Program Files/nodejs/node.exe");
  assert.equal(commandWord("   "), undefined);
});

test("a check is a command when its first word is a program on the PATH, a file in the repository or a shell built-in", () => {
  const { root, env } = place();
  for (const c of ["node --version", "az login", "scripts/check.sh", "./scripts/check.sh", "gradlew build", "echo ok", `"${process.execPath}" -e 0`, "CI=1 node x.js"]) {
    assert.ok(isCommand(c, root, env), c);
  }
  for (const c of ["All tests green", "Az összes teszt zöld", "Tests: the climb probe passes", "./scripts/missing.sh", "Node --version", ""]) {
    assert.equal(isCommand(c, root, env), false, c);
  }
});

test("a draft with a check in words is refused, saying where the text belongs; one with commands is taken", () => {
  const { root } = place();
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const steps = [{ id: "W1", title: "One", goal: "Do it.", acceptance: [] }];
  assert.throws(() => applyDraft(store, { id: "W", title: "Words", checks: ["node --version", "Az összes teszt zöld"], steps }), (e: unknown) => {
    assert.ok(e instanceof ActionError);
    assert.match(e.message, /check "Az összes teszt zöld" is not a command/);
    assert.match(e.message, /goes into a step's acceptance, or what the user should see into its review\.prepare/);
    return true;
  });
  assert.throws(() => store.readQueue("W"), "nothing written");
  assert.match(applyDraft(store, { id: "W", title: "Commands", checks: ["node --version", "scripts/check.sh"], steps }), /queue W created/);
  assert.equal(checkCommandIssue("node x.js", root), undefined);
});
