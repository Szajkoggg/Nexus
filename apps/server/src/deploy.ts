// Push on deploy: once a live instance's update is up (its successor signalled ready and took over), the deployed
// commit is pushed to the upstream remote of main, so GitHub has what runs. Only main, only fast-forward (a plain
// push, never force), never with a prompt: a credential prompt or a hang counts as a failed push. A failed push does
// not touch the deploy; the update log and the server panel say why.
//
// The setting lives in <NEXUS_HOME>/deploy.json (one writer: the server, from the dashboard's setting).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Why a failed git run failed, in a line: what git said (rejections, fatal errors), or that it timed out. */
function reason(err: unknown, timeout: number): string {
  const e = err as { killed?: boolean; signal?: string; stderr?: string; message?: string; code?: unknown };
  if (e.killed || e.signal) return `no answer within ${Math.round(timeout / 1000)} s (a credential prompt, or the network)`;
  const lines = String(e.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // "! [rejected]  <sha> -> main (fetch first)": the remote refused; say why in its words, and what it means.
  const rejected = lines.map((l) => /\[(remote )?rejected\].*?\(([^)]+)\)\s*$/.exec(l)).find(Boolean);
  if (rejected) {
    const why = rejected[2]!;
    const moved = /fetch first|non-fast-forward/i.test(why);
    return `the remote rejected it (${why})${moved ? ": its main has commits the deployed one does not; bring them into main and update again" : ""}`;
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
    return { result: "failed", text: reason(err, timeout), at };
  }
  if (!remote) return { result: "failed", text: "main has no upstream remote (git branch --set-upstream-to)", at };
  try {
    // A plain push of the commit itself: git refuses anything that is not a fast-forward; never --force.
    const r = await run(o.root, ["push", remote, `${sha}:refs/heads/main`], { env, timeout });
    const already = /Everything up-to-date/i.test(r.stderr + r.stdout);
    return { result: "pushed", text: `${sha.slice(0, 7)} ${already ? "was already" : "is now"} ${remote}/main`, at };
  } catch (err) {
    return { result: "failed", text: reason(err, timeout), at };
  }
}
