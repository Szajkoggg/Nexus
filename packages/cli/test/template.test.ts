// `nexus template list|show` and `nexus queue draft --template` (queue TQ, docs/protocol/planning.md "Queue templates"): the
// templates of the three layers, and a draft from one written into .nexus/drafts/, which the orchestrator then uploads
// with `nexus queue draft <file>` as any other. The server's part of the upload is played here by a stand-in that
// applies the orchestrator's queue.drafted events as the server does (applyDraft, then applied.jsonl).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, applyDraft, now } from "@nexus/protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../bin/nexus.js");

const MINE = `template:
  id: bugfix
  title: My bug fix
params:
  - name: issue
    description: the bug
title: "Mine: {{issue}}"
steps:
  - id: "{{id}}1"
    title: Fix {{issue}}
    goal: Fix it.
    kind: code
    size: S
`;

function setup() {
  const base = mkdtempSync(join(tmpdir(), "nexus-cli-template-"));
  const root = join(base, "project"), home = join(base, "home");
  mkdirSync(root); mkdirSync(home);
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: now() });
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: "o", NEXUS_HOME: home };
  const run = (...a: string[]) => {
    try { return { out: execFileSync(process.execPath, [CLI, ...a], { cwd: root, env, encoding: "utf8", stdio: "pipe" }), err: "" }; }
    catch (e) { return { out: "", err: String((e as { stderr?: string }).stderr ?? e) }; }
  };
  /** `nexus queue draft <file>` while a stand-in for the server applies its queue.drafted events. */
  const upload = async (file: string): Promise<string> => {
    const child = new Promise<string>((ok) => execFile(process.execPath, [CLI, "queue", "draft", file], { cwd: root, env, encoding: "utf8" }, (e, out, err) => ok(e ? `ERR ${err}` : out)));
    let done = false;
    void child.then(() => { done = true; });
    while (!done) {
      const applied = new Set(store.readApplied("o").entries.map((x) => x.event));
      for (const e of store.readEvents("o").entries) {
        if (e.type !== "queue.drafted" || applied.has(e.id)) continue;
        let ok = true; let message: string;
        try { message = applyDraft(store, e.definition); } catch (err) { ok = false; message = (err as Error).message; }
        store.appendApplied("o", { at: now(), event: e.id, ok, message });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return child;
  };
  return { root, home, store, run, upload };
}

test("a draft from a template is written into .nexus/drafts/ and uploads through the draft path as any other", async () => {
  const x = setup();
  const r = x.run("queue", "draft", "--template", "bugfix", "--set", "issue=the list crashes when empty", "--set", "area=the dashboard", "--id", "BF");
  assert.match(r.out, /^ok: draft \.nexus\/drafts\/BF\.yaml from template bugfix \(nexus\); complete it, then: nexus queue draft \.nexus\/drafts\/BF\.yaml/, r.err);
  const file = join(x.store.dir, "drafts", "BF.yaml");
  const text = readFileSync(file, "utf8");
  assert.match(text, /^# From template bugfix \(nexus: /);
  assert.match(text, /^id: BF$/m);
  assert.match(text, /^ {2}- id: BF1$/m);
  assert.match(text, /the list crashes when empty/);
  assert.doesNotMatch(text, /\{\{|^template:|^params:/m);
  assert.equal(x.store.queueIds().includes("BF"), false, "writing the draft uploads nothing");
  assert.match(await x.upload(".nexus/drafts/BF.yaml"), /^ok: queue BF created as proposed \(revision 1\)/);
  const q = x.store.readQueue("BF");
  assert.deepEqual(q.steps.map((s) => s.id), ["BF1", "BF2"]);
  assert.equal(q.title, "Fix: the list crashes when empty");
  assert.equal(q.coding, true);
  // The same id again: refused, the queue exists (and so does its draft file).
  assert.match(x.run("queue", "draft", "--template", "bugfix", "--set", "issue=x", "--set", "area=y", "--id", "BF").err, /queue BF exists already/);
  // Without --id: the template's id in capitals, numbered past what is taken.
  assert.match(x.run("queue", "draft", "--template", "spike", "--set", "question=Why?").out, /drafts\/SPIKE\.yaml/);
  assert.match(x.run("queue", "draft", "--template", "spike", "--set", "question=Why not?").out, /drafts\/SPIKE2\.yaml/);
});

test("a missing or unknown parameter, an unknown template or a bad --set is refused, and nothing is written", () => {
  const x = setup();
  assert.match(x.run("queue", "draft", "--template", "bugfix", "--set", "issue=x", "--id", "A").err, /template bugfix needs area \(the part of the project where it shows\): give it with --set name=value/);
  assert.match(x.run("queue", "draft", "--template", "bugfix", "--set", "issue=x", "--set", "area=y", "--set", "colour=red", "--id", "A").err, /has no parameter colour/);
  assert.match(x.run("queue", "draft", "--template", "nope", "--id", "A").err, /no template nope \(nexus template list\)/);
  assert.match(x.run("queue", "draft", "--template", "spike", "--set", "question", "--id", "A").err, /--set takes name=value/);
  assert.match(x.run("queue", "draft", "x.yaml", "--set", "a=b").err, /--set goes with --template/);
  assert.equal(existsSync(join(x.store.dir, "drafts", "A.yaml")), false);
});

test("template list and show: the three layers, a project's template over the global one over Nexus's", () => {
  const x = setup();
  const list = x.run("template", "list").out;
  for (const id of ["bugfix", "maintenance", "refactor", "spike", "ui-change"]) assert.match(list, new RegExp(`^${id} \\(nexus\\): `, "m"));
  assert.match(list, /^spike \(nexus\): Spike \(params: question \[timebox\]\)$/m);
  mkdirSync(join(x.home, "templates"));
  writeFileSync(join(x.home, "templates", "bugfix.yaml"), MINE);
  writeFileSync(join(x.home, "templates", "broken.yaml"), "title: no header\n");
  assert.match(x.run("template", "list").out, /^bugfix \(global, over nexus\): My bug fix \(params: issue\)$/m);
  mkdirSync(join(x.root, "nexus-templates"));
  writeFileSync(join(x.root, "nexus-templates", "bugfix.yaml"), MINE.replace("My bug fix", "The project's bug fix"));
  const now3 = x.run("template", "list").out;
  assert.match(now3, /^bugfix \(project, over nexus and global\): The project's bug fix \(params: issue\)$/m);
  assert.match(now3, /^not used: .*broken\.yaml \(global\): template:/m);
  const show = x.run("template", "show", "bugfix").out;
  assert.match(show, /^bugfix: The project's bug fix \(project: .*nexus-templates.bugfix\.yaml; replaces the nexus and global one\)$/m);
  assert.match(show, /^ {2}issue: the bug \(required\)$/m);
  assert.match(show, /^title: "Mine: \{\{issue\}\}"$/m);
  assert.match(x.run("template", "show", "broken").err, /template broken cannot be used: .*broken\.yaml: template:/);
  // The project's template is the one a draft uses.
  assert.match(x.run("queue", "draft", "--template", "bugfix", "--set", "issue=x", "--id", "M").out, /from template bugfix \(project\)/);
  assert.match(readFileSync(join(x.store.dir, "drafts", "M.yaml"), "utf8"), /^title: "Mine: x"$/m);
});
