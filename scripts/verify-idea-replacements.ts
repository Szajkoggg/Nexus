// IC4 round 2: assert the rendered replacement, not just the API, after user actions, reload and Back.
// Build the dashboard, then: node scripts/verify-idea-replacements.ts <temporary report directory>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EdgeBrowser, profileDir } from "./capture/edge.ts";
import { collector, describe, findFaults, type Page } from "./capture/faults.ts";
import { captureViews, freePort, startInstance, type Instance } from "./capture/run.ts";
import { instanceEnv, parseViews } from "./capture/views.ts";

const root = resolve("."), temp = mkdtempSync(join(tmpdir(), "nexus-idea-replacements-"));
const out = resolve(process.argv[2] ?? join(tmpdir(), "nexus-review/IC/IC4/round2"));
assert(!out.startsWith(root), "review files belong outside the checkout");
mkdirSync(out, { recursive: true });
const log: string[] = [];
const record = (text: string) => { log.push(text); console.log(text); };
let browser: EdgeBrowser | undefined, instance: Instance | undefined;
try {
  const home = join(temp, "home"), data = join(temp, "data");
  mkdirSync(home, { recursive: true }); mkdirSync(data, { recursive: true });
  const port = await freePort();
  const seeded = spawnSync(process.execPath, [join(root, "scripts/capture/seed-idea-replacements.ts"), data], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: instanceEnv(process.env, { home, port, fakes: { claude: "", codex: "" } }),
  });
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  const sourceFile = join(data, "demo/docs/ideas/replacement-examples.md"), original = readFileSync(sourceFile, "utf8");
  instance = await startInstance({ root, home, port });
  browser = await EdgeBrowser.launch(profileDir(temp, "replacement"));
  const b = browser;
  const until = async (name: string, predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`Timed out: ${name}`);
  };
  const exists = (selector: string) => b.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = (selector: string) => b.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).innerText`);
  const click = (label: string) => until(label, () => b.click(label));
  const fill = async (selector: string, value: string) => {
    await until(selector, () => exists(selector)); assert(await b.type(value, selector));
  };
  const reload = async (selector: string) => {
    // The old DOM can still exist just after reload() returns. Require a new document before reading it.
    await b.evaluate("window.ic4BeforeReload = true; location.reload(); true");
    await until(`reload ${selector}`, () => b.evaluate<boolean>(`!window.ic4BeforeReload && document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(selector)})`).catch(() => false));
  };
  const backToOverview = async () => {
    await b.evaluate("history.back(); true");
    await until("Back closes the note", async () => await exists("[data-ideas-overview] [data-idea-entry]") && !(await exists("[data-idea-note]")) && !(await exists("[data-idea-status-form]")));
  };
  const openForm = async (ref: string) => {
    await click("Replacement examples");
    const action = `[data-decision=${JSON.stringify(ref)}] button`;
    await until("dated entry action", () => b.click({ selector: action }));
    await until("status form", () => exists("[data-idea-status-form]"));
  };
  await b.open(`${instance.url}/#/demo`, 1440, 900, readFileSync("scripts/capture/reset-ideas.js", "utf8"));
  await click("Ideas"); await click("Overview");
  await fill('input[aria-label="Filter notes…"]', "Replacement examples");
  const target = "docs/ideas/choice-c.md#2026-11-15";
  for (const [date, operation, oldMarker] of [["11", "reopen", true], ["12", "replace", true], ["13", "replace", false]] as const) {
    const ref = `docs/ideas/replacement-examples.md#2026-11-${date}`;
    const row = `[data-idea-entry=${JSON.stringify(ref)}]`;
    await until("overview date", () => exists(row));
    const before = await text(row);
    assert.equal(before.includes("→ choice-b.md#2026-11-15"), oldMarker, "the original marker is visibly rendered before the user action");
    await openForm(ref);
    await fill("[data-idea-status-form] select:not([data-decision-select])", operation);
    if (operation === "replace") await fill("[data-decision-select]", target);
    await fill("[data-idea-status-form] textarea", `Explicit ${operation} for date ${date}.`);
    await click("Save decision");
    await until("saved note", () => exists("[data-idea-note]"));
    const checkRow = async () => {
      const shown = await text(row);
      assert(!shown.includes("choice-b.md"), `old B arrow remains: ${shown}`);
      if (operation === "reopen") {
        assert(!shown.includes("→"), `reopened date still has a replacement arrow: ${shown}`);
        assert(shown.includes("No linked work"), shown);
        assert(!shown.includes("Replaced"), shown);
      } else {
        assert(shown.includes("Replaced"), shown);
        assert(shown.includes("→ choice-c.md#2026-11-15"), `effective C target is missing: ${shown}`);
      }
    };
    await backToOverview(); await checkRow();
    await reload(row); await checkRow();
    // The current assessment must agree; the original B survives only in explicitly historical note details.
    await openForm(ref);
    // Compare actual rendered code text, including the full path/date, rather than reading a response field.
    const currentCodes = () => b.evaluate<string[]>('[...document.querySelectorAll(\'[data-box="Current assessment"] code\')].map(e => e.innerText)');
    const inspect = async () => {
      assert(!(await text('[data-box="Current assessment"]')).includes("choice-b.md"));
      assert.deepEqual(await currentCodes(), operation === "replace" ? [target] : []);
      if (oldMarker) {
        await click("Overridden historical note marker");
        const noteText = await b.evaluate<string>("[...document.querySelectorAll('summary')].find(e => e.textContent === 'Overridden historical note marker').parentElement.innerText");
        assert(noteText.includes("Overridden historical note marker"), noteText);
        assert(noteText.includes("docs/ideas/choice-b.md#2026-11-15"), noteText);
      }
    };
    await inspect(); await reload("[data-idea-status-form]"); await inspect();
    await click("Cancel"); await until("note after cancel", () => exists("[data-idea-note]"));
    await backToOverview(); await checkRow();
    record(`PASS: ${oldMarker ? "legacy B" : "no marker"} -> ${operation === "reopen" ? "active without arrow" : "visible C"}; actual row and current assessment after save, reload and Back`);
  }
  assert.equal(readFileSync(sourceFile, "utf8"), original, "UI actions must not edit the note");
  const list = parseViews(readFileSync("scripts/capture/examples/idea-replacements.yaml", "utf8"));
  const scripts = new Map(list.views.map((v) => [v.script!, readFileSync(v.script!, "utf8")]));
  const shots = await captureViews(list.views, b, { base: instance.url, out, side: "after", scripts });
  assert(shots.every((s) => !s.error), JSON.stringify(shots));
  const faults = findFaults(await b.evaluate<Page>(collector("[data-box]", "[data-edge]")));
  record(`ideas-replacements@1440: ${describe(faults).join("; ")}`);
  assert.equal(faults.through.length + faults.overlaps.length + faults.cut.length, 0, JSON.stringify(faults));
  record("All three browser cases passed. The original Markdown is byte-identical; no queue or real project was touched.");
} catch (error) {
  record(`FAIL: ${error instanceof Error ? error.stack : error}`);
  await browser?.shot(join(out, "failure.png"));
  throw error;
} finally {
  await browser?.close(); await instance?.stop();
  writeFileSync(join(out, "replacement-verification.txt"), log.join("\n") + "\n");
  rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
