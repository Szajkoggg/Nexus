// A project's rules files (AGENTS.md, CLAUDE.md): the check the dashboard shows on the project's page, and the fix,
// a user action only (a dashboard write, no CLI command, no event). The fix changes the project's own files, which
// the user commits: Nexus writes them and commits nothing. It is refused while a run in the project's own checkout
// holds it (running, waiting, paused), and when the files changed since the user saw the change (`version`).
// The check itself is pure: @nexus/protocol's rules.ts.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError, CHECKOUT_RUN_STATES, checkRules, loadProjectState, type ProjectStore, type RulesCheck } from "@nexus/protocol";
import { checkoutPath, samePath } from "./worktree.ts";

const FILES = { agents: "AGENTS.md", claude: "CLAUDE.md" } as const;

/** The check, and the version of the files it was made from (what the fix must find unchanged). */
export interface ProjectRules extends RulesCheck { version: string; root: string }

interface Read { text?: string; utf8: boolean }
function read(path: string): Read {
  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return { utf8: true }; }
  const text = buf.toString("utf8");
  return { text, utf8: Buffer.from(text, "utf8").equals(buf) };
}

function readAll(root: string) {
  const agents = read(join(root, FILES.agents));
  const claude = read(join(root, FILES.claude));
  const version = createHash("sha256").update(JSON.stringify([agents.text ?? null, claude.text ?? null])).digest("hex").slice(0, 16);
  return { agents, claude, version };
}

/** The check of a project root's rules files. */
export function projectRules(root: string): ProjectRules {
  const { agents, claude, version } = readAll(root);
  return { ...checkRules({ agents: agents.text, claude: claude.text }), version, root };
}

/**
 * The user's fix, as the check offered it at `version`. Returns what was done; refuses (409) while a run holds the
 * project's own checkout, when the files changed since, when there is nothing to fix, or when a file is not UTF-8.
 */
export function fixProjectRules(store: ProjectStore, version: unknown): string {
  const state = loadProjectState(store);
  const root = state.project.root;
  const busy = state.queues.find((q) => q.run && CHECKOUT_RUN_STATES.includes(q.run.state) && samePath(checkoutPath(state, q), root));
  if (busy) {
    throw new ActionError(`queue ${busy.id}'s run is not finished in the project's checkout (${busy.run!.state}): change its rules files once it is, so that its worker does not find them changed under it`, 409);
  }
  const files = readAll(root);
  if (typeof version !== "string" || version !== files.version) {
    throw new ActionError("AGENTS.md or CLAUDE.md changed since the change was shown: look at it again", 409);
  }
  const check = checkRules({ agents: files.agents.text, claude: files.claude.text });
  if (!check.fix) throw new ActionError("there is nothing to fix: both runtimes see the project's rules", 409);
  for (const c of check.fix.changes) {
    const f = c.file === "AGENTS.md" ? files.agents : files.claude;
    if (!f.utf8) throw new ActionError(`${c.file} is not UTF-8 text: Nexus does not rewrite it; change it by hand`, 409);
  }
  for (const c of check.fix.changes) {
    // A new file must still be new: never overwrite one that appeared meanwhile.
    writeFileSync(join(root, c.file), c.after, { encoding: "utf8", flag: c.action === "create" ? "wx" : "w" });
  }
  const done = check.fix.changes.map((c) => `${c.file} ${c.action === "create" ? "created" : "changed"}`).join(", ");
  return `${done}; nothing is committed: commit ${check.fix.changes.length === 1 ? "it" : "them"} yourself`;
}
