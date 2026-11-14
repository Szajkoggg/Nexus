// Pushing what was accepted (src/accepted.ts), against the fake `claude` and a temporary bare repository as the
// remote: never a real remote. The project's checkout is on a branch with no upstream, so the push goes to origin and
// creates the branch there. A pre-receive hook in the bare repository refuses pushes while a file "reject" exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, approveQueue, confirmProvisional, loadProjectState, newId, routeAnswers } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

process.env.NEXUS_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
const G = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...G, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup(o: { push?: boolean; remote?: boolean; steps?: number; goal?: string; levels?: (1 | 2 | 3)[]; counts?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nexus-accepted-"));
  process.env.NEXUS_HOME = join(base, "home");
  process.env.FAKE_LOG = join(base, "fake.log");
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nif [ -f reject ]; then echo 'refused for the test' >&2; exit 1; fi\nexit 0\n");
  const root = join(base, "project");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nexus/\n");
  const commit = (name: string) => { writeFileSync(join(root, `${name}.txt`), `${name}\n`); git(root, "add", "-A"); git(root, "commit", "-q", "-m", name); return git(root, "rev-parse", "HEAD"); };
  const a = commit("A");
  if (o.remote !== false) {
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "-u", "origin", "main");
    assert.equal(git(root, "remote", "get-url", "origin"), remote, "the remote is the temporary bare repository");
  }
  git(root, "checkout", "-q", "-b", "nexus/Q"); // no upstream: the push goes to origin and creates the branch

  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const p = store.readProject();
  store.writeProject({
    ...p, defaults: { ...p.defaults, push_accepted: o.push !== false, provisional_counts: o.counts ?? true },
    // With levels, an orchestrator reviews levels 2 and 3 (its decisions are written as its events below).
    ...(o.levels ? { orchestrator: { runtime: "claude" as const, notify: true, session: null } } : {}),
  });
  const steps = Array.from({ length: o.steps ?? 3 }, (_, i) => ({
    id: `Q${i + 1}`, title: `Step ${i + 1}`, goal: o.goal ?? "FAKE: done", acceptance: [], ...(o.levels?.[i] ? { review: { level: o.levels[i]! } } : {}),
  }));
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", review_level: 1, stop_conditions: [], checks: [], steps, approvals: [], history: [] });
  approveQueue(store, "Q");
  const engine: Engine = new Engine(store, () => { routeAnswers(store); engine.onChange(loadProjectState(store)); });
  const timer = setInterval(() => engine.onChange(loadProjectState(store)), 150);
  const queue = () => loadProjectState(store).queues.find((q) => q.id === "Q")!;
  const step = (id: string) => queue().steps.find((s) => s.id === id)!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; push: ${JSON.stringify(store.readPush("Q"))}; steps: ${queue().steps.map((s) => `${s.id}=${s.status}`).join(" ")}`);
  const remoteBranch = () => { try { return git(remote, "rev-parse", "--verify", "--quiet", "refs/heads/nexus/Q"); } catch { return undefined; } };
  /** The step's review, with its HEAD recorded. */
  const inReview = (id: string) => until(`${id} in review`, () => step(id).status === "review" && !!store.readPush("Q")?.review[id], LONGER.step);
  const stop = () => { clearInterval(timer); engine.shutdown(); };
  /** The orchestrator's decision, as `nexus review provisional|accept` writes it. */
  const orchestrator = (type: "review.provisional" | "review.accepted", stepId: string) => {
    store.writeSession({ protocol: 1, id: "orch", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: new Date().toISOString() });
    store.appendEvent({ v: 1, id: newId(), at: new Date().toISOString(), session: "orch", type, queue: "Q", step: stepId });
    engine.onChange(loadProjectState(store));
  };
  return { base, remote, root, store, engine, queue, step, until, commit, remoteBranch, inReview, orchestrator, stop, a };
}

test("an accepted step pushes the commit it was reviewed at, not a later one of the next step", async () => {
  const x = setup();
  try {
    const b = x.commit("B"); // the step's work
    x.engine.start("Q");
    await x.inReview("Q1");
    assert.equal(x.store.readPush("Q")!.review.Q1!.sha, b, "HEAD when the step entered review");
    const c = x.commit("C"); // the next step's work, before the push
    x.engine.acceptReview("Q", "Q1", "Fine; keep the old names in Q2.", "next"); // a note does not change what is pushed
    await x.until("the push", () => x.store.readPush("Q")?.steps.Q1?.result === "pushed", LONGER.processes);
    assert.equal(x.remoteBranch(), b, "the reviewed commit, created on the remote");
    assert.notEqual(x.remoteBranch(), c);
    const push = x.store.readPush("Q")!;
    assert.deepEqual([push.pushed?.sha, push.pushed?.remote, push.pushed?.branch, push.pushed?.step], [b, "origin", "nexus/Q", "Q1"]);
    assert.match(push.steps.Q1!.text, new RegExp(`^${b.slice(0, 7)} is now origin/nexus/Q`));
    assert.equal(push.error, undefined);
  } finally { x.stop(); }
});

test("a rejected push shows and the acceptance stands; the next acceptance pushes again, and so does push again", async () => {
  const x = setup();
  try {
    const b = x.commit("B");
    x.engine.start("Q");
    await x.inReview("Q1");
    writeFileSync(join(x.remote, "reject"), "");
    x.engine.acceptReview("Q", "Q1");
    await x.until("the failure", () => x.store.readPush("Q")?.steps.Q1?.result === "failed", LONGER.processes);
    let push = x.store.readPush("Q")!;
    assert.match(push.error!.text, /the remote rejected it \(pre-receive hook declined\)/);
    assert.equal(push.error!.step, "Q1");
    assert.equal(x.step("Q1").status, "done", "the acceptance stands");
    assert.equal(x.remoteBranch(), undefined);
    assert.equal(loadProjectState(x.store).queues[0]!.push?.error?.step, "Q1", "the dashboard's view has it");
    assert.match(x.engine.pushAgain("Q"), /pushing step Q1 of queue Q again/);
    await x.engine.pusher.settled();
    assert.equal(x.store.readPush("Q")!.steps.Q1!.result, "failed", "still refused");

    // The next acceptance pushes again; its commit includes Q1's, which shows as pushed with it.
    rmSync(join(x.remote, "reject"));
    await x.inReview("Q2");
    const d = x.commit("D"); // Q3's work, made before Q2's push: not part of it
    x.engine.acceptReview("Q", "Q2");
    await x.until("Q2 pushed", () => x.store.readPush("Q")?.steps.Q2?.result === "pushed", LONGER.processes);
    push = x.store.readPush("Q")!;
    assert.equal(x.remoteBranch(), b);
    assert.equal(push.steps.Q1!.result, "pushed");
    assert.match(push.steps.Q1!.text, /^pushed with step Q2/);
    assert.equal(push.error, undefined);
    assert.throws(() => x.engine.pushAgain("Q"), /no failed push/);

    // Push again, after a refusal that has since been lifted.
    await x.inReview("Q3");
    assert.equal(x.store.readPush("Q")!.review.Q3!.sha, d);
    writeFileSync(join(x.remote, "reject"), "");
    x.engine.acceptReview("Q", "Q3");
    await x.until("Q3 refused", () => x.store.readPush("Q")?.steps.Q3?.result === "failed", LONGER.processes);
    rmSync(join(x.remote, "reject"));
    x.engine.pushAgain("Q");
    await x.until("Q3 pushed again", () => x.store.readPush("Q")?.steps.Q3?.result === "pushed", LONGER.processes);
    assert.equal(x.remoteBranch(), d);
    assert.equal(x.store.readPush("Q")!.error, undefined);
  } finally { x.stop(); }
});

test("with push_accepted off nothing is pushed; without a remote the step says so", async () => {
  const off = setup({ push: false, steps: 1 });
  try {
    off.commit("B");
    off.engine.start("Q");
    await off.inReview("Q1");
    off.engine.acceptReview("Q", "Q1");
    await off.until("done", () => off.step("Q1").status === "done");
    await new Promise((r) => setTimeout(r, 600));
    await off.engine.pusher.settled();
    assert.equal(off.remoteBranch(), undefined);
    assert.deepEqual(off.store.readPush("Q")!.steps, {});
  } finally { off.stop(); }

  const none = setup({ remote: false, steps: 1 });
  try {
    none.commit("B");
    none.engine.start("Q");
    await none.inReview("Q1");
    none.engine.acceptReview("Q", "Q1");
    await none.until("the outcome", () => !!none.store.readPush("Q")?.steps.Q1);
    const s = none.store.readPush("Q")!.steps.Q1!;
    assert.equal(s.result, "skipped");
    assert.match(s.text, /not pushed: nexus\/Q has no upstream remote and there is no origin/);
  } finally { none.stop(); }
});

test("after a rejection nothing of the queue is pushed until a newer revision is approved", async () => {
  const x = setup();
  try {
    const b = x.commit("B");
    x.engine.start("Q");
    await x.inReview("Q1");
    writeFileSync(join(x.remote, "reject"), "");
    x.engine.acceptReview("Q", "Q1");
    await x.until("the failure", () => x.store.readPush("Q")?.steps.Q1?.result === "failed", LONGER.processes);
    rmSync(join(x.remote, "reject"));
    x.commit("C");
    await x.inReview("Q2");
    x.engine.rejectStep("Q", "Q2", "Not this way.");
    assert.throws(() => x.engine.pushAgain("Q"), /was rejected: nothing of it is pushed/);
    await new Promise((r) => setTimeout(r, 600));
    await x.engine.pusher.settled();
    assert.equal(x.remoteBranch(), undefined, "nothing pushed after the rejection");
    // The orchestrator's revision, approved by the user: pushing works again.
    applyDraft(x.store, { id: "Q", title: "Queue", review_level: 1, steps: [
      { id: "Q1", title: "Step 1", goal: "FAKE: done" }, { id: "Q2", title: "Step 2", goal: "FAKE: done" },
      { id: "Q3", title: "Step 3", goal: "FAKE: done" }, { id: "Q2b", title: "Revert Q2", goal: "FAKE: done" },
    ] });
    approveQueue(x.store, "Q");
    x.engine.pushAgain("Q");
    await x.until("pushed", () => x.store.readPush("Q")?.steps.Q1?.result === "pushed", LONGER.processes);
    assert.equal(x.remoteBranch(), b, "the accepted commit, not the rejected step's");
  } finally { x.stop(); }
});

// ---------------------------------------------------------------- provisional acceptances (review level 3)

test("provisional work counts (the default): a provisional acceptance pushes like an acceptance", async () => {
  const x = setup({ steps: 2, goal: "FAKE: commit", levels: [3, 1] });
  try {
    x.engine.start("Q");
    await x.inReview("Q1");
    const q1 = x.store.readPush("Q")!.review.Q1!.sha!;
    x.orchestrator("review.provisional", "Q1");
    await x.until("Q1 pushed", () => x.store.readPush("Q")?.steps.Q1?.result === "pushed", LONGER.processes);
    assert.equal(x.remoteBranch(), q1);
    assert.equal(x.step("Q1").provisional?.confirmed, undefined, "pushed though not confirmed");
    await x.inReview("Q2");
    x.engine.acceptReview("Q", "Q2");
    await x.until("Q2 pushed", () => x.store.readPush("Q")?.steps.Q2?.result === "pushed", LONGER.processes);
    assert.equal(x.remoteBranch(), x.store.readPush("Q")!.review.Q2!.sha);
  } finally { x.stop(); }
});

test("provisional work does not count: neither it nor an accepted step built on it is pushed until the user confirms it", async () => {
  const x = setup({ steps: 2, goal: "FAKE: commit", levels: [3, 1], counts: false });
  try {
    x.engine.start("Q");
    await x.inReview("Q1");
    x.orchestrator("review.provisional", "Q1");
    await x.until("Q1 held", () => x.store.readPush("Q")?.steps.Q1?.result === "held");
    assert.deepEqual(x.store.readPush("Q")!.steps.Q1!.held_by, ["Q/Q1"]);

    await x.inReview("Q2");
    const q2 = x.store.readPush("Q")!.review.Q2!.sha!;
    x.engine.acceptReview("Q", "Q2"); // accepted by the user, but built on Q1's provisional work
    await x.until("Q2 held", () => x.store.readPush("Q")?.steps.Q2?.result === "held");
    assert.match(x.store.readPush("Q")!.steps.Q2!.text, /provisional work the user has not confirmed \(Q\/Q1\)/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(x.remoteBranch(), undefined, "nothing pushed before the confirmation");

    confirmProvisional(x.store, "Q", "Q1");
    x.engine.onChange(loadProjectState(x.store));
    await x.until("Q2 pushed", () => x.store.readPush("Q")?.steps.Q2?.result === "pushed", LONGER.processes);
    assert.equal(x.remoteBranch(), q2, "the newest acceptance, Q1's work in it");
  } finally { x.stop(); }
});
