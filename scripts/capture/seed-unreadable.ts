// A seed for the capture tool (queue CI13): a test project "demo" whose queue SW stopped at SW2, which committed one
// change, and whose git cannot read that commit within the server's 10 s limit: `git log` checks each commit's
// signature (log.showSignature) with a gpg program that sleeps longer. Before CI13 the stop box said the step left
// nothing and Continue lifted the stop without Keep or Discard; since, the commits are "cannot be read" with Retry, and
// Continue waits. The views wait past the limit. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME
// set to the development instance's; it writes only under the data directory and that NEXUS_HOME.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-unreadable.ts <data dir>");
const root = join(dir, "demo").replaceAll("\\", "/");
const tools = join(dir, "tools").replaceAll("\\", "/");
mkdirSync(root, { recursive: true });
mkdirSync(tools, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...a], {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const script = (name: string, body: string) => { writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`); return `${tools}/${name}`; };

git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), ".nexus/\n");
writeFileSync(join(root, "README.md"), "# Demo app\n");
git("add", "-A"); git("commit", "-q", "-m", "Start");
const start = git("rev-parse", "HEAD");
writeFileSync(join(root, "export.ts"), "export const csv = (rows: string[][]) => rows.map((r) => r.join(\",\")).join(\"\\n\");\n");
git("add", "export.ts");
// A signature git takes at commit time; checking it is what the slow gpg program below makes slow.
const sign = script("sign.sh", "cat >/dev/null\necho '[GNUPG:] SIG_CREATED D 1 8 00 0 0' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n'");
git("-c", `gpg.program=${sign}`, "commit", "-q", "-S", "-m", "Export: rows as CSV");
const end = git("rev-parse", "HEAD");
git("config", "log.showSignature", "true");
git("config", "gpg.program", script("slow-gpg.sh", "sleep 14\nexit 1"));

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
const session = (role: SessionFile["role"], title: string, queue?: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: "claude", title, cwd: root, launched_by: "nexus", created_at: ago(120), ...(queue ? { queue } : {}) };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const user = session("user", "You");
session("orchestrator", "Orchestrator");
const w = session("worker", "SW worker", "SW");

st.writeQueue({
  protocol: 1, id: "SW", title: "Export to CSV", revision: 1, status: "proposed", checks: ["npm test"],
  stop_conditions: ["If the export needs a new dependency, ask before adding it."],
  steps: [
    { id: "SW1", title: "The export's shape", goal: "Write down the columns the export has.", acceptance: ["The columns listed"] },
    { id: "SW2", title: "The export", goal: "Export the rows as CSV.", acceptance: ["A test exports three rows"] },
    { id: "SW3", title: "The download button", goal: "Offer the export in the table's menu.", acceptance: ["The menu has Export"] },
  ],
});
approveQueue(st, "SW");
emit(w, 90, { type: "step.started", queue: "SW", step: "SW1" });
emit(w, 80, { type: "step.done", queue: "SW", step: "SW1", summary: "Five columns: id, name, amount, currency, date." });
emit(user, 75, { type: "review.accepted", queue: "SW", step: "SW1" });
emit(w, 70, { type: "step.started", queue: "SW", step: "SW2" });
emit(w, 50, { type: "queue.stop", queue: "SW", step: "SW2", condition: "If the export needs a new dependency, ask before adding it.", reason: "Quoting the amounts needs a CSV library; the first part is committed." });
// SW2's round: its one commit, made in its one turn.
st.writeGit("SW", { protocol: 1, steps: { SW2: [{ session: w.id, start, end, started_at: ago(70), ended_at: ago(50), turns: [{ start, end }] }] } });
console.log(`seeded ${root}`);
