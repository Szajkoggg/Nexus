// Push on deploy: once a live instance's update is up (its successor signalled ready and took over), the deployed
// commit is pushed to the upstream remote of main, so GitHub has what runs. Only main, only fast-forward (a plain
// push, never force), never with a prompt: a credential prompt or a hang counts as a failed push. A failed push does
// not touch the deploy; the update log and the server panel say why.
//
// The setting lives in <NEXUS_HOME>/deploy.json (one writer: the server, from the dashboard's setting).
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { nexusHome, now } from "@nexus/protocol";

const exec = promisify(execFile);

/** How long a push may take; then it counts as failed (a prompt nobody answers, a network that hangs). */
export const PUSH_TIMEOUT_MS = 60_000;
/** No prompt of any kind: git's own (terminal) and Git Credential Manager's (a window). */
export const PUSH_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } as const;

export interface DeploySettings { push_on_deploy: boolean }
const DEFAULTS: DeploySettings = { push_on_deploy: true };

export const deploySettingsFile = () => join(nexusHome(), "deploy.json");

export function readDeploySettings(): DeploySettings {
  const f = deploySettingsFile();
  if (!existsSync(f)) return { ...DEFAULTS };
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as Partial<DeploySettings>;
    return { push_on_deploy: typeof v.push_on_deploy === "boolean" ? v.push_on_deploy : DEFAULTS.push_on_deploy };
  } catch { return { ...DEFAULTS }; }
}

export function writeDeploySettings(s: DeploySettings): void {
  const f = deploySettingsFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(s, null, 2) + "\n");
  renameSync(f + ".tmp", f);
}

/** Runs git in `root`; tests replace it to see how the push is run. */
export type GitRunner = (root: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ stdout: string; stderr: string }>;

export const runGit: GitRunner = async (root, args, opts) => {
  const r = await exec("git", args, { cwd: root, windowsHide: true, env: opts.env, timeout: opts.timeout, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
};

export interface PushResult {
  /** pushed: the remote's main is the deployed commit; skipped: not tried (off, not main, not live); failed: tried. */
  result: "pushed" | "failed" | "skipped";
  text: string;
  at: string;
}

const DEPLOY_MOVED = "its main has commits the deployed one does not; bring them into main and update again";

/**
 * Why a failed git run failed, in a line: what git said (rejections, fatal errors), or that it timed out. `moved`: what
 * a rejection because the remote branch moved on means for this push.
 */
export function pushFailure(err: unknown, timeout: number, moved = DEPLOY_MOVED): string {
  const e = err as { killed?: boolean; signal?: string; stderr?: string; message?: string; code?: unknown };
  if (e.killed || e.signal) return `no answer within ${Math.round(timeout / 1000)} s (a credential prompt, or the network)`;
  const lines = String(e.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // "! [rejected]  <sha> -> main (fetch first)": the remote refused; say why in its words, and what it means.
  const rejected = lines.map((l) => /\[(remote )?rejected\].*?\(([^)]+)\)\s*$/.exec(l)).find(Boolean);
  if (rejected) {
    const why = rejected[2]!;
    return `the remote rejected it (${why})${/fetch first|non-fast-forward/i.test(why) ? `: ${moved}` : ""}`;
  }
  const said = lines.filter((l) => /^(error|fatal|remote: (error|fatal))/i.test(l) && !/^error: failed to push some refs/i.test(l));
  const text = (said.length ? said : lines.slice(-2)).join("; ") || String(e.message ?? err).split("\n")[0]!;
  return text.length > 300 ? text.slice(0, 299) + "…" : text;
}

/**
 * Pushes the commit a live instance deployed from main to main's upstream remote. Returns what happened; never
 * throws. `ref` is what the update deployed (the predecessor's update ref; undefined when not known).
 */
export async function pushDeployed(o: {
  root: string; ref: string | undefined; live: boolean;
  settings?: DeploySettings; run?: GitRunner; timeout?: number;
}): Promise<PushResult> {
  const at = now();
  const run = o.run ?? runGit;
  const timeout = o.timeout ?? PUSH_TIMEOUT_MS;
  const settings = o.settings ?? readDeploySettings();
  const skipped = (text: string): PushResult => ({ result: "skipped", text, at });
  if (!o.live) return skipped("not a live instance (a development checkout is never pushed)");
  if (!settings.push_on_deploy) return skipped("push on deploy is off");
  if (o.ref !== "main") return skipped(o.ref ? `the deployed ref is ${o.ref}, not main` : "the deployed ref is not known");
  const env = { ...process.env, ...PUSH_ENV };
  let sha: string, remote: string;
  try {
    sha = (await run(o.root, ["rev-parse", "HEAD"], { env, timeout })).stdout.trim();
    remote = (await run(o.root, ["config", "--get", "branch.main.remote"], { env, timeout }).catch(() => ({ stdout: "" }))).stdout.trim();
  } catch (err) {
    return { result: "failed", text: pushFailure(err, timeout), at };
  }
  if (!remote) return { result: "failed", text: "main has no upstream remote (git branch --set-upstream-to)", at };
  try {
    // A plain push of the commit itself: git refuses anything that is not a fast-forward; never --force.
    const r = await run(o.root, ["push", remote, `${sha}:refs/heads/main`], { env, timeout });
    const already = /Everything up-to-date/i.test(r.stderr + r.stdout);
    return { result: "pushed", text: `${sha.slice(0, 7)} ${already ? "was already" : "is now"} ${remote}/main`, at };
  } catch (err) {
    return { result: "failed", text: pushFailure(err, timeout), at };
  }
}

// ---------------------------------------------------------------- what changed for agents

// A commit that changes something agents rely on (a CLI command, a briefing, the protocol, a file an agent reads or
// writes) carries a line "Agents: <what changed>" (AGENTS.md). At a successful deploy the successor collects those
// lines from the commits between the old and the new version and records them in <NEXUS_HOME>/deploy-changes.jsonl
// (one writer: the server); every project's orchestrator session older than the deploy is told them once.

export interface AgentChange { commit: string; text: string }
/** One deploy's changes for agents. `key` is what an orchestrator's applied.jsonl records once it was told. */
export interface DeployChanges { key: string; at: string; from: string; to: string; changes: AgentChange[] }

export const deployChangesFile = () => join(nexusHome(), "deploy-changes.jsonl");

/** Every recorded deploy's changes, oldest first, each key once. */
export function readDeployChanges(): DeployChanges[] {
  const f = deployChangesFile();
  if (!existsSync(f)) return [];
  const seen = new Set<string>();
  const out: DeployChanges[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as DeployChanges;
      if (!d.key || seen.has(d.key)) continue;
      seen.add(d.key);
      out.push(d);
    } catch { /* a torn line: skip it */ }
  }
  return out;
}

/** Records a deploy's changes, unless that deploy is recorded already (a successor taking the same hand-over again). */
export function recordDeployChanges(d: DeployChanges): boolean {
  if (readDeployChanges().some((x) => x.key === d.key)) return false;
  const f = deployChangesFile();
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(d) + "\n");
  return true;
}

/**
 * The "Agents:" lines of a commit message. A line may wrap: the lines after it, up to a blank line or a trailer
 * ("Co-Authored-By: …"), belong to it.
 */
export function parseAgentLines(message: string): string[] {
  const lines = message.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^Agents:\s*(.*)$/.exec(lines[i]!.trim());
    if (!m) continue;
    let text = m[1]!.trim();
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim();
      if (!next || /^[A-Za-z][A-Za-z-]*:\s/.test(next)) break;
      text += ` ${next}`;
      i = j;
    }
    if (text) out.push(text);
  }
  return out;
}

/**
 * The Agents: lines of the commits from `from` (excluded) to `to`, oldest first; or why there are none to tell: the
 * old commit was not recorded (a hand-over from a server older than this), is unknown here, or is not an ancestor of
 * the new one. Local git only, no network.
 */
export async function collectAgentChanges(root: string, from: string | undefined, to: string, run: GitRunner = runGit): Promise<{ changes: AgentChange[] } | { skipped: string }> {
  const opts = { env: process.env, timeout: 30_000 };
  if (!from) return { skipped: "the predecessor did not record the commit it ran (a hand-over from a server older than this)" };
  try { await run(root, ["cat-file", "-e", `${from}^{commit}`], opts); }
  catch { return { skipped: `the old commit ${from.slice(0, 7)} is not in this repository` }; }
  try { await run(root, ["merge-base", "--is-ancestor", from, to], opts); }
  catch { return { skipped: `the old commit ${from.slice(0, 7)} is not an ancestor of ${to.slice(0, 7)}` }; }
  const log = (await run(root, ["log", "--reverse", "--format=%H%x1f%B%x1e", `${from}..${to}`], opts)).stdout;
  const changes: AgentChange[] = [];
  for (const rec of log.split("\x1e")) {
    const [sha, body] = rec.replace(/^\s+/, "").split("\x1f");
    if (!sha || body === undefined) continue;
    for (const text of parseAgentLines(body)) changes.push({ commit: sha.slice(0, 7), text });
  }
  return { changes };
}

/** What an orchestrator is told: each deploy's changes, in order. */
export function describeDeployChanges(list: DeployChanges[]): string {
  const parts = list.map((d) => `Nexus was deployed (${d.from.slice(0, 7)}..${d.to.slice(0, 7)}). What changed for agents, oldest first:\n${d.changes.map((c) => `- ${c.text} (${c.commit})`).join("\n")}`);
  return `${parts.join("\n\n")}\nYour briefing may still describe the older way; where it differs, follow these.`;
}
