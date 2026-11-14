// The capture tool for Nexus's own pictures: takes one fixed-viewport picture per view of the dashboard, from a
// development instance with seeded test projects, and the same views at the step's base commit as the befores.
//
//   node scripts/capture.ts <views.yaml> [--out <dir>] [--step <queue>/<step> | --base <commit>] [--no-before]
//
// The pictures go to --out, else <temp>/nexus-review/<queue>/<step>/ (or .../capture/), outside the working tree.
// The view list's format is in scripts/capture/views.ts (and `nexus help review`). The afters come from this checkout
// (its dashboard is built first); the befores from a temporary git worktree at the base commit (the step's first
// start in .nexus/queues/<queue>/git.yaml, or --base), which gets `npm ci` and a dashboard build and is removed
// afterwards. Each side runs its own development instance: port 4318 and up, NEXUS_HOME in a new temporary folder,
// the fake runtimes, and NEXUS_DIR, NEXUS_HANDOVER and NEXUS_SESSION cleared, so it never touches a real project or the
// live instance. The view list's `seed` script writes the test projects (run with each side's code).
//
// It never blocks: a view it cannot take is reported (take it by hand under the same conditions), and so is a seed that
// does not fit the base commit's code. Exit code 0 then too; 2 for a wrong command line or view list; 3 when the
// temporary worktree could not be removed (remove it by hand: the path is printed).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { findNexusDir } from "@nexus/protocol";
import { EdgeBrowser, profileDir } from "./capture/edge.ts";
import { captureViews, freePort, startInstance, type Instance } from "./capture/run.ts";
import { baseOf, instanceEnv, parseViews, report, type Shot, type View } from "./capture/views.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, step: { type: "string" }, base: { type: "string" }, "no-before": { type: "boolean" }, help: { type: "boolean", short: "h" } },
});
const usage = "node scripts/capture.ts <views.yaml> [--out <dir>] [--step <queue>/<step> | --base <commit>] [--no-before]";
const fail = (msg: string, code = 2): never => { console.error(`capture: ${msg}`); process.exit(code); };
if (o.help || positionals.length !== 1) { console.log(usage); process.exit(o.help ? 0 : 2); }

const posix = (p: string) => p.replaceAll("\\", "/");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const root = posix(git(process.cwd(), "rev-parse", "--show-toplevel"));

let list;
try { list = parseViews(readFileSync(positionals[0]!, "utf8")); } catch (e) { fail((e as Error).message); }
const { views, seed } = list!;
if (seed && !existsSync(join(root, seed))) fail(`no seed script at ${seed} (a path from the repository root)`);

// The base commit: --base, else the step's first start. Read before anything runs; the .nexus folder is only read.
let base = o.base;
const stepId = o.step?.split("/")[1];
if (!base && o.step && !o["no-before"]) {
  const [queue, step] = o.step.split("/");
  if (!queue || !step) fail("--step is <queue>/<step>, e.g. RS/RS3");
  const nexusDir = process.env.NEXUS_DIR ?? findNexusDir(root);
  const file = nexusDir ? join(nexusDir, "queues", queue!, "git.yaml") : undefined;
  if (!file || !existsSync(file)) fail(`no ${file ?? ".nexus/queues/<queue>/git.yaml"}: give --base <commit>`);
  base = baseOf(readFileSync(file!, "utf8"), step!);
  if (!base) fail(`step ${o.step} has no recorded start in ${file}: give --base <commit>`);
}
if (o["no-before"]) base = undefined;
if (base) base = git(root, "rev-parse", "--verify", `${base}^{commit}`);
// Outside the working tree: nexus review add copies the pictures into the queue's folder, and untracked files in a
// worktree would block its cleanup.
const out = posix(resolve(o.out ?? join(tmpdir(), "nexus-review", ...(o.step ? o.step.split("/") : ["capture"]))));
mkdirSync(out, { recursive: true });

const tmp = posix(mkdtempSync(join(tmpdir(), "nexus-capture-")));
const log = (s: string) => console.log(`capture: ${s}`);
const notes: string[] = [];
const shots: Shot[] = [];
const instances: Instance[] = [];
let browser: EdgeBrowser | undefined;
let worktree: string | undefined;
let worktreeLeft = false;

/** Runs a command in `cwd`; throws with the end of its output. npm goes through the shell (npm.cmd on Windows). */
function run(cwd: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  // npm through the shell (npm.cmd on Windows) as one command line: its arguments here are fixed words.
  const r = cmd === "npm"
    ? spawnSync(`npm ${args.join(" ")}`, { cwd, env, encoding: "utf8", shell: true, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(cmd, args, { cwd, env, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${`${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}`.trim().slice(-600)}`);
}

/** One side: seed the test projects with the checkout's code, start its instance, take the views. */
async function side(which: "before" | "after", checkout: string): Promise<void> {
  const home = `${tmp}/${which}/home`, data = `${tmp}/${which}/data`;
  mkdirSync(home, { recursive: true }); mkdirSync(data, { recursive: true });
  const port = await freePort(which === "after" ? 4318 : 4340);
  if (seed) {
    try {
      run(checkout, process.execPath, [join(checkout, seed), data], instanceEnv(process.env, { home, port, fakes: { claude: "", codex: "" } }));
    } catch (e) {
      throw new Error(`the seed does not fit the code ${which === "before" ? `at ${base!.slice(0, 7)}` : "of this checkout"}: ${(e as Error).message}`);
    }
  }
  const inst = await startInstance({ root: checkout, home, port });
  instances.push(inst);
  log(`${which}: development instance on ${inst.url} (pid ${inst.pid}), data in ${data}`);
  browser ??= await EdgeBrowser.launch(profileDir(tmp, "edge"));
  shots.push(...await captureViews(views, browser, { base: inst.url, out, side: which, log }));
  await inst.stop();
}

const sideFailed = (which: "before" | "after", why: string, vs: View[] = views) => {
  notes.push(`${which}: ${why}`);
  for (const v of vs) if (!shots.some((s) => s.key === v.key && s.side === which)) shots.push({ key: v.key, side: which, error: `${which} not taken: ${why.split("\n")[0]}` });
};

try {
  // The afters: this checkout, its dashboard built as it is now.
  try {
    log("building this checkout's dashboard");
    run(root, "npm", ["run", "build", "-w", "@nexus/web"], process.env);
    await side("after", root);
  } catch (e) { sideFailed("after", (e as Error).message); }

  if (base) {
    try {
      worktree = `${tmp}/base`;
      log(`befores: a temporary worktree at ${base.slice(0, 7)} in ${worktree} (npm ci and a dashboard build take a while)`);
      git(root, "worktree", "add", "--detach", worktree, base);
      run(worktree, "npm", [existsSync(join(worktree, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund"], process.env);
      run(worktree, "npm", ["run", "build", "-w", "@nexus/web"], process.env);
      if (seed) {
        // The same seed, run with the base commit's code.
        mkdirSync(dirname(join(worktree, seed)), { recursive: true });
        copyFileSync(join(root, seed), join(worktree, seed));
      }
      await side("before", worktree);
    } catch (e) { sideFailed("before", (e as Error).message); }
  }
} finally {
  for (const i of instances) await i.stop();
  await browser?.close();
  if (worktree && existsSync(worktree)) {
    // Git for Windows (without core.longpaths) cannot delete node_modules' paths beyond 260 characters: it drops the
    // worktree, deletes what it can and fails with "Directory not empty". So git is asked a few times, what it leaves
    // is deleted by Node (which handles long paths, with retries for a file held a moment longer), and the worktree
    // list is pruned. The junctions in node_modules point inside the worktree, and rmSync does not follow them.
    let why = "";
    for (let i = 0; i < 3 && existsSync(worktree); i++) {
      try { git(root, "worktree", "remove", "--force", worktree); } catch (e) { why ||= String((e as { stderr?: string }).stderr ?? (e as Error).message).trim(); await new Promise((r) => setTimeout(r, 1500)); }
    }
    if (existsSync(worktree)) {
      try { rmSync(worktree, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch (e) { why += ` / ${(e as Error).message}`; }
    }
    try { git(root, "worktree", "prune"); } catch { /* nothing to prune */ }
    const listed = git(root, "worktree", "list", "--porcelain").split("\n").some((l) => posix(l) === `worktree ${worktree}`);
    if (existsSync(worktree) || listed) {
      worktreeLeft = true;
      notes.push(`THE TEMPORARY WORKTREE ${worktree} COULD NOT BE REMOVED (${why.split("\n")[0]}): remove it with git worktree remove --force ${worktree} (or delete the folder, then git worktree prune)`);
    } else if (why) notes.push(`the temporary worktree was removed on a later try (git said first: ${why.split("\n")[0]})`);
  }
  if (!worktreeLeft) rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
}

const text = report(views, shots, { step: stepId, base, beforeRun: !!base, notes });
writeFileSync(join(out, "capture-report.txt"), text + "\n");
console.log(`\n${text}\n\n(also in ${posix(relative(root, join(out, "capture-report.txt")))})`);
if (isAbsolute(out) && worktreeLeft) process.exit(3);
process.exit(0);
