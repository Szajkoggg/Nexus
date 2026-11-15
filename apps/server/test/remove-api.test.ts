// Removing a project through the server's API (src/removal.ts, src/main.ts), on a real server with a temporary
// NEXUS_HOME and the fake Claude Code: "Remove from Nexus" takes it off the list, stops its agents, closes its watcher
// and leaves its .nexus, and `nexus project add` brings it back as it was; "Delete Nexus's data" deletes the .nexus
// too, nothing else; while something runs it is refused (409) with the reason; only the dashboard's own page may ask,
// a remote request without the token is refused, and the nexus CLI has no command for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ProjectStore, now, readRegistry, writeRegistry, type ProjectState, type ProjectSummary, type QueueFile, type RemovalView } from "@nexus/protocol";
import { assertTempHome, spawnServer } from "./helpers.ts";
import { LONGER, serverUp, sleep, untilAsync } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "../../../packages/cli/bin/nexus.js");
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const isRunning = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Remove and Delete through the API: what goes, what stays, what keeps it, and who may ask", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-remove-api-"));
  const home = join(base, "home");
  assertTempHome(home);
  process.env.NEXUS_HOME = home;
  const queue = (store: ProjectStore, id: string, extra: Partial<QueueFile> = {}) => store.writeQueue({
    protocol: 1, id, title: `Queue ${id}`, revision: 1, status: "approved", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: `${id}1`, title: "One", goal: "", acceptance: [] }], ...extra,
  } as QueueFile);
  const make = (id: string) => {
    const root = join(base, id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.md"), `${id}'s own file\n`);
    return { root, store: ProjectStore.init(root, { id, name: `Project ${id}`, root }) };
  };
  // p: nothing runs; a scheduled start and a worktree Nexus made (beside the checkout, with a file of its own).
  const p = make("p");
  queue(p.store, "S");
  p.store.writeStart("S", { protocol: 1, at: new Date(Date.now() + 86_400_000).toISOString(), by: "user", revision: 1, created_at: now() });
  const tree = join(base, "p.worktrees", "T");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "work.txt"), "the worktree's file\n");
  queue(p.store, "T", { worktree: tree.replaceAll("\\", "/"), branch: "nexus/T", integration: true });
  // q: a stopped queue (its run halted) keeps it.
  const q = make("q");
  queue(q.store, "X", { status: "stopped" });
  q.store.writeRun("X", { protocol: 1, session: "w", state: "halted", started_at: now(), updated_at: now() });
  // r: its .nexus is a junction to a folder elsewhere.
  const r = { root: join(base, "r") };
  mkdirSync(r.root);
  const elsewhere = join(base, "elsewhere");
  ProjectStore.init(join(base, "elsewhere-root"), { id: "r", name: "Project r", root: r.root });
  symlinkSync(join(base, "elsewhere-root", ".nexus"), join(r.root, ".nexus"), "junction");
  mkdirSync(elsewhere);
  writeRegistry({ protocol: 1, projects: [{ id: "p", root: p.root }, { id: "q", root: q.root }, { id: "r", root: r.root }] });

  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "", NEXUS_CLAUDE: join(here, "fake-claude.ts") });
  const url = `http://127.0.0.1:${port}`;
  const page = { "content-type": "application/json", origin: url, "sec-fetch-site": "same-origin" };
  const post = (path: string, body: unknown, headers: Record<string, string> = page) => fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
  const get = async <T>(path: string) => (await (await fetch(url + path)).json()) as T;
  const ids = async () => (await get<ProjectSummary[]>("/api/projects")).map((x) => x.id).sort();
  let ws: WebSocket | undefined;
  try {
    await serverUp(url + "/api/projects");
    assert.deepEqual(await ids(), ["p", "q", "r"]);

    // Only the dashboard's own page, from this machine or with the token: a script (no Origin), another site, a remote
    // device without the token. The CLI has no command for it.
    assert.equal((await post("/api/projects/p/remove", {}, { "content-type": "application/json" })).status, 403, "no Origin: an agent's script");
    assert.equal((await post("/api/projects/p/remove", {}, { ...page, origin: "http://evil.example" })).status, 403, "a foreign Origin");
    assert.equal((await post("/api/projects/p/remove", {}, { ...page, "sec-fetch-site": "cross-site" })).status, 403, "not from the page");
    assert.equal((await post("/api/projects/p/remove", {}, { ...page, "x-forwarded-for": "100.64.0.9" })).status, 401, "a remote request without the token");
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_HOME: home };
    delete env.NEXUS_DIR; delete env.NEXUS_SESSION;
    assert.throws(() => execFileSync(process.execPath, [CLI, "project", "remove", "p"], { env, encoding: "utf8", stdio: "pipe" }), /nexus project add <path> \| nexus project list/);
    assert.deepEqual(await ids(), ["p", "q", "r"], "nothing was removed");

    // The orchestrator of p has a process (between turns); its pid, to see it stop.
    assert.equal((await post("/api/projects/p/orchestrator/messages", { text: "hello" })).status, 200);
    let pid = 0;
    await untilAsync("the orchestrator's turn to end", async () => {
      const o = await get<{ state: string; runtime: { pid?: number } | null }>("/api/projects/p/orchestrator");
      pid = o.runtime?.pid ?? 0;
      return o.state === "idle" && pid > 0;
    }, LONGER.step);
    assert.ok(isRunning(pid), "the orchestrator's process runs");

    // What the confirmation shows.
    const view = await get<RemovalView>("/api/projects/p/removal");
    assert.deepEqual(view.blockers, []);
    assert.deepEqual(view.scheduled.map((x) => x.queue), ["S"]);
    assert.deepEqual(view.worktrees.map((x) => [x.queue, x.branch, x.exists]), [["T", "nexus/T", true]]);
    assert.equal(view.name, "Project p");
    const before = await get<ProjectState>("/api/projects/p/state");

    // Something runs in q: refused with the reason, nothing changed.
    const blocked = await post("/api/projects/q/remove", {});
    assert.equal(blocked.status, 409);
    const why = (await blocked.json()) as { error: string; blockers: string[] };
    assert.deepEqual(why.blockers, ["queue X is stopped"]);
    assert.match(why.error, /cannot be removed while something runs in it: queue X is stopped/);
    assert.deepEqual((await get<RemovalView>("/api/projects/q/removal")).blockers, ["queue X is stopped"]);
    assert.deepEqual(await ids(), ["p", "q", "r"]);

    // Remove from Nexus: off the list and the registry, its agents stopped, its watcher closed; .nexus stays.
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: string[] = [];
    ws.on("message", (m) => messages.push(String(m)));
    await new Promise((res) => ws!.once("open", res));
    const removed = await post("/api/projects/p/remove", {});
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.deepEqual(await ids(), ["q", "r"]);
    assert.deepEqual(readRegistry().projects.map((x) => x.id), ["q", "r"]);
    assert.ok(existsSync(join(p.root, ".nexus", "project.yaml")), ".nexus stays");
    assert.equal(isRunning(pid), false, "the orchestrator's process has ended");
    assert.equal((await fetch(`${url}/api/projects/p/state`)).status, 404);
    await sleep(300);
    messages.length = 0;
    writeFileSync(join(p.root, ".nexus", "queues", "S", "touch.txt"), "x");
    await sleep(800);
    assert.deepEqual(messages.filter((m) => m.includes('"project":"p"')), [], "no change of p is reported: its watcher is closed");

    // Added again with the CLI, under the id it had: its state is as it was.
    const added = execFileSync(process.execPath, [CLI, "project", "add", p.root], { env, encoding: "utf8" });
    assert.match(added, /^ok: project p /);
    await untilAsync("p to be back", async () => (await ids()).includes("p"));
    const after = await get<ProjectState>("/api/projects/p/state");
    assert.deepEqual(after.queues, before.queues, "its queues as they were");
    assert.deepEqual(after.questions, before.questions);

    // Delete Nexus's data: the name must be typed; then .nexus goes, the project's own files and the worktree stay.
    const unnamed = await post("/api/projects/p/remove", { delete_data: true });
    assert.equal(unnamed.status, 400);
    assert.match(((await unnamed.json()) as { error: string }).error, /type its name/);
    const deleted = await post("/api/projects/p/remove", { delete_data: true, name: "Project p" });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.match(((await deleted.json()) as { result: { deleted: string } }).result.deleted, /\/p\/\.nexus$/);
    assert.equal(existsSync(join(p.root, ".nexus")), false, ".nexus is gone");
    assert.equal(readFileSync(join(p.root, "README.md"), "utf8"), "p's own file\n");
    assert.equal(readFileSync(join(tree, "work.txt"), "utf8"), "the worktree's file\n", "the worktree stays");
    assert.deepEqual(await ids(), ["q", "r"]);

    // r's .nexus is a junction: Delete is refused and its target stays; Remove from Nexus may go.
    const rView = await get<RemovalView>("/api/projects/r/removal");
    assert.match(rView.delete_refused ?? "", /link or junction/);
    const rDelete = await post("/api/projects/r/remove", { delete_data: true, name: "Project r" });
    assert.equal(rDelete.status, 409);
    assert.ok(existsSync(join(base, "elsewhere-root", ".nexus", "project.yaml")), "the junction's target stays");
    assert.deepEqual(await ids(), ["q", "r"], "nothing was removed");
    assert.equal((await post("/api/projects/r/remove", {})).status, 200);
    assert.deepEqual(await ids(), ["q"]);
    assert.ok(existsSync(join(base, "elsewhere-root", ".nexus", "project.yaml")));
  } finally {
    ws?.close();
    child.kill();
  }
});
