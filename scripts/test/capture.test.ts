// The capture tool (scripts/capture.ts): the view list format, the cleared environment of its development instance
// (with decoys for NEXUS_HANDOVER, NEXUS_DIR and NEXUS_SESSION), and a view that fails being reported while the others
// are taken. No browser here: the views run through a fake one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureViews, freePort, startInstance, type Browser } from "../capture/run.ts";
import { baseOf, instanceEnv, parseViews, report } from "../capture/views.ts";

test("a view list: keys give the width, defaults for height and settle, actions checked", () => {
  const list = parseViews(`
seed: scripts/capture/seed-demo.ts
views:
  - key: waiting-tab@492
    route: "#/demo/UI/UI1"
    label: Waiting tab
    actions:
      - click: Accept the step
      - click: { selector: "img[alt='Waiting tab']" }
      - type: { text: hello, into: textarea }
      - press: Escape
      - wait: 300
  - key: rail@1440
    route: "#/demo"
    height: 1000
    settle: 0
`);
  assert.equal(list.seed, "scripts/capture/seed-demo.ts");
  const [a, b] = list.views;
  assert.deepEqual([a!.key, a!.width, a!.height, a!.settle, a!.label, a!.actions.length], ["waiting-tab@492", 492, 844, 1500, "Waiting tab", 5]);
  assert.deepEqual([b!.width, b!.height, b!.settle, b!.actions], [1440, 1000, 0, []]);
  assert.equal(parseViews(`views: [{ key: "x@1280", route: "#/p" }]`).views[0]!.height, 900, "900 high from 1024 wide");
});

test("a wrong view list is refused with every problem and where it is", () => {
  assert.throws(() => parseViews("views: []"), /views: a list of at least one view/);
  assert.throws(() => parseViews("- a\n- b"), /a mapping with `views:`/);
  assert.throws(() => parseViews(": :"), /not valid YAML|problem/);
  let message = "";
  try {
    parseViews(`
seed: 3
views:
  - key: Waiting@492
    route: "#/x"
  - key: tab@492
    route: demo
    height: tall
    actions:
      - click: ""
      - hover: x
      - type: { into: textarea }
      - wait: -1
  - key: tab@492
    route: "#/x"
`);
  } catch (e) { message = (e as Error).message; }
  for (const part of [
    "seed: a path", "views[0].key: a view key", "views[1] (tab@492).route: a dashboard route", "views[1] (tab@492).height: a whole number of pixels",
    "views[1] (tab@492).actions[0]: click:", "views[1] (tab@492).actions[1]: one of", "views[1] (tab@492).actions[2]: type:", "views[1] (tab@492).actions[3]: wait:",
    "views[2].key: tab@492 twice",
  ]) assert.ok(message.includes(part), `${part}\n${message}`);
});

test("the instance's environment: NEXUS_DIR, NEXUS_HANDOVER and NEXUS_SESSION cleared, its own home and port, fake runtimes; never 4317", () => {
  const env = instanceEnv({ PATH: "p", NEXUS_DIR: "d", NEXUS_HANDOVER: "h", NEXUS_SESSION: "s", NEXUS_HOST: "0.0.0.0", NEXUS_HOME: "real" },
    { home: "/tmp/h", port: 4320, fakes: { claude: "fc", codex: "fx" } });
  assert.deepEqual(env, { PATH: "p", NEXUS_HOME: "/tmp/h", NEXUS_PORT: "4320", NEXUS_CLAUDE: "fc", NEXUS_CODEX: "fx" });
  assert.throws(() => instanceEnv({}, { home: "h", port: 4317, fakes: { claude: "", codex: "" } }), /4317 is the live instance's/);
});

test("a development instance started with decoys in the parent's environment ignores them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-capture-env-"));
  // A decoy hand-over folder (a server that took it would refuse to start, or write into it) and a decoy project.
  const handover = join(dir, "decoy-handover"); mkdirSync(handover);
  writeFileSync(join(handover, "handover.json"), JSON.stringify({ from: "live" }));
  const nexusDir = join(dir, "decoy-project", ".nexus"); mkdirSync(nexusDir, { recursive: true });
  const parentEnv = { ...process.env, NEXUS_HANDOVER: handover, NEXUS_DIR: nexusDir, NEXUS_SESSION: "decoy-session" };
  const home = join(dir, "home");
  const root = join(import.meta.dirname, "../..");
  const inst = await startInstance({ root, home, port: await freePort(4360), parentEnv });
  try {
    assert.deepEqual(await (await fetch(`${inst.url}/api/projects`)).json(), [], "its own NEXUS_HOME: no projects");
    assert.ok(inst.port >= 4318);
  } finally { await inst.stop(); }
  assert.deepEqual(readdirSync(handover), ["handover.json"], "the decoy hand-over folder untouched");
  assert.equal(readFileSync(join(handover, "handover.json"), "utf8"), JSON.stringify({ from: "live" }));
  assert.deepEqual(readdirSync(nexusDir), [], "the decoy project untouched");
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("a view that fails is reported with why; the others are taken", async () => {
  const taken: string[] = [];
  const browser: Browser = {
    async open(url) { if (url.includes("#/broken")) throw new Error("the page did not open: net::ERR_FAILED"); },
    async click(t) { return typeof t === "string" ? t !== "Nope" : true; },
    async type() { return true; },
    async press() { return true; },
    async shot(file) { taken.push(file); },
  };
  const views = parseViews(`
views:
  - { key: one@1440, route: "#/demo", settle: 0 }
  - { key: two@1440, route: "#/demo", settle: 0, actions: [{ click: Accept }, { click: Nope }] }
  - { key: three@390, route: "#/broken", settle: 0 }
  - { key: four@390, route: "#/demo", settle: 0, label: Four }
`).views;
  const shots = await captureViews(views, browser, { base: "http://127.0.0.1:4318", out: "C:/out", side: "after" });
  assert.deepEqual(shots, [
    { key: "one@1440", side: "after", file: "C:/out/one@1440.png" },
    { key: "two@1440", side: "after", error: 'action 2 (click "Nope") found nothing to act on' },
    { key: "three@390", side: "after", error: "the page did not open: net::ERR_FAILED" },
    { key: "four@390", side: "after", file: "C:/out/four@390.png" },
  ]);
  assert.deepEqual(taken, ["C:/out/one@1440.png", "C:/out/four@390.png"]);

  const befores = await captureViews(views, browser, { base: "http://127.0.0.1:4340", out: "C:/out", side: "before" });
  const text = report(views, [...shots, ...befores], { step: "RS3", base: "8800a052844399b3465d3cea89d53c4d701c0f85", beforeRun: true });
  assert.match(text, /^capture: 4 of 8 picture\(s\) taken \(befores at 8800a05\)/);
  assert.match(text, /NOT TAKEN: two@1440 after: action 2 \(click "Nope"\) found nothing to act on/);
  assert.match(text, /NOT TAKEN: three@390 before: the page did not open/);
  assert.match(text, /Take those by hand under the same conditions/);
  const adds = text.split("\n").filter((l) => l.startsWith("nexus review add"));
  assert.deepEqual(adds, [
    `nexus review add RS3 C:/out/one@1440.before.png --key one@1440 --role before --label "one@1440, before"`,
    `nexus review add RS3 C:/out/four@390.before.png --key four@390 --role before --label "Four, before"`,
    `nexus review add RS3 C:/out/one@1440.png --key one@1440 --role after --label "one@1440"`,
    `nexus review add RS3 C:/out/four@390.png --key four@390 --role after --label "Four"`,
  ], "befores first, nothing for what was not taken");
  assert.match(report(views.slice(0, 1), shots.slice(0, 1), { beforeRun: false }), /--role result/, "without befores: results");
});

test("the base commit of a step is its first start in git.yaml", () => {
  const yaml = "protocol: 1\nsteps:\n  RS3:\n    - session: s1\n      start: 8800a05\n    - session: s2\n      start: abcdef0\n  RS4: []\n";
  assert.equal(baseOf(yaml, "RS3"), "8800a05");
  assert.equal(baseOf(yaml, "RS4"), undefined);
  assert.equal(baseOf(yaml, "RS9"), undefined);
});
