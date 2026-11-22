// A scripted browser check of the plan's reorder (queue PV3): on a development instance with the fake runtimes and
// the test project of scripts/capture/seed-plan.ts, it moves queues in the dashboard's plan, once with "After…" and
// once by dragging, and checks that the plan files say what the rule says (docs/protocol/planning.md, "The plan"): the moved queue
// waits for the one chosen, and those that waited for it wait for its old predecessors, set by the user.
//
//   node scripts/check-plan-reorder.ts
//
// Port 4318 and up, NEXUS_HOME in a new temporary folder (never the live instance or a real project); headless Edge or
// Chrome (NEXUS_CAPTURE_BROWSER). Exit code 0 when every check holds, 1 when one fails.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "@nexus/protocol";
import { EdgeBrowser, profileDir } from "./capture/edge.ts";
import { freePort, startInstance } from "./capture/run.ts";
import { instanceEnv } from "./capture/views.ts";

const root = join(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "nexus-plan-check-"));
const home = join(tmp, "home"), data = join(tmp, "data");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const say = (s: string) => console.log(`check: ${s}`);

const port = await freePort();
execFileSync(process.execPath, [join(root, "scripts/capture/seed-plan.ts"), data], { env: instanceEnv(process.env, { home, port, fakes: { claude: "", codex: "" } }), stdio: "inherit" });
const store = new ProjectStore(join(data, "demo", ".nexus"));
const after = (q: string) => (store.readPlan(q)?.after ?? []).map((e) => `${e.queue}:${e.by}`).join(",");
/** Waits until `what` holds (the server writes the files), up to 8 s; records a failure otherwise. */
async function expect(what: string, got: () => string, want: string): Promise<void> {
  for (let t = Date.now(); Date.now() - t < 8000; await sleep(200)) if (got() === want) { say(`ok: ${what}`); return; }
  failures.push(`${what}: wanted ${want}, got ${got()}`);
  say(`FAILED: ${what}: wanted ${want}, got ${got()}`);
}

const instance = await startInstance({ root, home, port });
let browser: EdgeBrowser | undefined;
try {
  browser = await EdgeBrowser.launch(profileDir(tmp, "check"));
  await browser.open(`${instance.url}/#/demo`, 1440, 900);
  await sleep(1500);
  if (!(await browser.click("All queues of Demo app"))) throw new Error("no \"All queues of Demo app\"");
  await sleep(1200);

  // "After…": CL after MP. DP waited for CL (the orchestrator's): it waits for RN, CL's old predecessor, now the user's.
  if (!(await browser.click({ selector: "[data-plan-move='CL']" }))) throw new Error("no After… on CL");
  await sleep(300);
  if (!(await browser.click({ selector: "[data-plan-after='MP']" }))) throw new Error("no \"after MP\" in CL's menu");
  await expect("CL after MP (After…)", () => after("CL"), "MP:user");
  await expect("DP waits for CL's old predecessor", () => after("DP"), "RN:user");

  // Dragging: AP onto XB. Nothing waited for AP.
  await sleep(1200); // the view takes the change
  const dropped = await browser.evaluate<boolean>(`(() => {
    const from = document.querySelector("[data-plan-card='AP']"), to = document.querySelector("[data-plan-card='XB']");
    if (!from || !to || from.getAttribute("draggable") !== "true") return false;
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    from.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  })()`);
  if (!dropped) throw new Error("could not drag AP onto XB");
  await expect("AP after XB (dragged)", () => after("AP"), "XB:user");

  // To the front: MP first. CL waited for MP: it waits for MP's old predecessors (RN, RV) instead.
  await sleep(1200);
  if (!(await browser.click({ selector: "[data-plan-move='MP']" }))) throw new Error("no After… on MP");
  await sleep(300);
  if (!(await browser.click({ selector: "[data-plan-after='']" }))) throw new Error("no \"First\" in MP's menu");
  await expect("MP first (none before it)", () => after("MP"), "");
  await expect("CL waits for MP's old predecessors", () => after("CL"), "RN:user,RV:user");
} catch (e) {
  failures.push((e as Error).message);
  say(`FAILED: ${(e as Error).message}`);
} finally {
  await browser?.close();
  await instance.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* a file still held: the folder is in the system's temp */ }
}
say(failures.length ? `${failures.length} failed` : "every check holds");
process.exit(failures.length ? 1 : 0);
