// Only a command can be a check (queue EF, P1): a check is run by the shell in the queue's checkout, so a text that
// describes a verification ("all tests green") is no check; it belongs in a step's acceptance or its review.prepare.
// A check looks like a command when its first word can run: a program or script on the PATH, a file in the project's
// repository, or one of the few shell built-ins a check uses. The draft path refuses a check that does not
// (applyDraft), and the engine records one of an older, approved queue as "not a command" instead of failing the step
// (apps/server/src/check-runs.ts). docs/protocol/checks.md, "Checks run by Nexus".
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Shell built-ins a check may begin with (sh and cmd.exe), matched as written: lowercase. */
const BUILTINS = new Set(["echo", "exit", "cd", "pushd", "call", "set", "export", "true", "false", ":", ".", "source", "env"]);

/**
 * The check's first word, the program it runs: leading `NAME=value` assignments (sh) are skipped, and a quoted word
 * is read without its quotes. Undefined for an empty check.
 */
export function commandWord(check: string): string | undefined {
  const words = check.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return first?.replace(/^(["'])(.*)\1$/, "$2") || undefined;
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * Whether the word is a program on the PATH, on Windows with the PATHEXT extensions. There the file system finds a
 * name in any case; a word with a capital letter must match the file's name as written, so that "Az összes teszt" is
 * no call of az.cmd.
 */
function onPath(word: string, env: NodeJS.ProcessEnv): boolean {
  const win = process.platform === "win32";
  const path = env.PATH ?? env.Path ?? env.path ?? "";
  const exts = win ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const exact = win && word !== word.toLowerCase();
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const found = exts.map((e) => `${word}${e}`).filter((n) => isFile(join(dir, n)));
    if (!found.length) continue;
    if (!exact) return true;
    let listed: string[];
    try { listed = readdirSync(dir); } catch { continue; }
    if (listed.some((n) => found.some((f) => n === f || n === `${word}${f.slice(word.length).toLowerCase()}`))) return true;
  }
  return false;
}

/**
 * Whether the check looks like a command: its first word is a shell built-in, a file (a path, relative to `root`, the
 * project's repository, or absolute), a file in `root` by its name (gradlew), or a program on the PATH.
 */
export function isCommand(check: string, root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const word = commandWord(check);
  if (!word) return false;
  if (BUILTINS.has(word)) return true;
  if (/[\\/]/.test(word) || isAbsolute(word)) return existsSync(isAbsolute(word) ? word : resolve(root, word));
  if (isFile(join(root, word))) return true;
  return onPath(word, env);
}

/** Why a check of a draft is refused, or undefined when it looks like a command. */
export function checkCommandIssue(check: string, root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isCommand(check, root, env)) return undefined;
  const word = commandWord(check);
  return `check "${check}" is not a command (${word ? `"${word}" is no program on the PATH nor a file in the repository` : "it is empty"}): a check is a command Nexus runs in the queue's checkout. A verification described in words goes into a step's acceptance, or what the user should see into its review.prepare`;
}
