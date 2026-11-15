// A seed for the capture tool: a test project "demo" with a step (RF1) whose review material is files, not pictures: a
// JSON report (written on one line), a YAML plan, a CSV table with quoted fields, and a Markdown write-up. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// there.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-files.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const NL = String.fromCharCode(10);

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, orchestrator: { session: null } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(24 * 60));
const w: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "worker", runtime: "claude", title: "RF worker", cwd: root, launched_by: "nexus", created_at: ago(120), queue: "RF" };
st.writeSession(w);
const emit = (min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: w.id, ...body } as Event);

st.writeQueue({ protocol: 1, id: "RF", title: "Import of the shop's orders", revision: 1, status: "proposed", review_level: 1, stop_conditions: [], checks: ["npm test"],
  steps: [{ id: "RF1", title: "Order import", goal: "Orders from the old shop come in as orders of the new model.", acceptance: ["Every sample order comes in", "A report of what was skipped"] }] });
approveQueue(st, "RF");

const files = join(root, "tmp/review/RF1");
mkdirSync(files, { recursive: true });
const file = (name: string, text: string) => { const p = join(files, name).replaceAll("\\", "/"); writeFileSync(p, text); return p; };

const report = file("import-report.json", JSON.stringify({
  run: { started: "2026-11-15T09:12:04Z", finished: "2026-11-15T09:12:41Z", source: "shop-export-2026-11.csv" },
  orders: { read: 1284, imported: 1279, skipped: 5 },
  skipped: [
    { order: "A-10442", reason: "no customer", line: 211 },
    { order: "A-10871", reason: "currency \"DKK\" not supported", line: 640 },
    { order: "A-11003", reason: "total does not match its lines", line: 772, detail: { total: 412.5, lines: 402.5 } },
  ],
  warnings: ["3 orders without a delivery date: the order date was used"],
  ok: true,
}));
const plan = file("import-plan.yaml", [
  "# How the old shop's orders map onto the new model",
  "source: shop-export-2026-11.csv",
  "batch: 200",
  "mapping:",
  "  order_no: id",
  "  customer: customer.id",
  "  placed: placed_at        # ISO 8601, local time",
  "  total: total.amount",
  "  currency: total.currency",
  "skip_when:",
  "  - no customer",
  "  - currency not in [EUR, USD]",
  "  - total does not match its lines",
  "dry_run: false",
  "",
].join(NL));
const rows = [
  "order_no,customer,placed,total,currency,note",
  "A-10421,C-2201,2026-11-02,129.90,EUR,",
  "A-10422,C-0087,2026-11-02,54.00,EUR,\"gift wrap, no invoice\"",
  "A-10423,C-1930,2026-11-02,980.00,USD,\"said \"\"call first\"\"\"",
  "A-10424,C-2201,2026-11-03,12.50,EUR,",
  "A-10425,C-3302,2026-11-03,310.00,EUR,\"two parcels:",
  "front door, then garage\"",
  "A-10426,C-0412,2026-11-03,75.20,EUR,",
  "",
  ...Array.from({ length: 30 }, (_, i) => `A-${10427 + i},C-${String(1000 + ((i * 37) % 2400)).padStart(4, "0")},2026-11-${String(4 + Math.floor(i / 6)).padStart(2, "0")},${(20 + ((i * 53) % 900)).toFixed(2)},${i % 7 === 3 ? "USD" : "EUR"},${i % 9 === 4 ? "\"express, signed\"" : ""}`),
  "",
];
const table = file("orders-sample.csv", rows.join("\r\n"));
const notes = file("import-notes.md", [
  "# Order import: notes",
  "",
  "The import reads the old shop's export and writes **orders of the new model**. Five of 1284 orders were skipped;",
  "the [report](import-report.json) lists them.",
  "",
  "## What was decided",
  "",
  "- Orders in a currency other than EUR or USD are skipped, not converted.",
  "- An order without a delivery date takes its order date.",
  "- Totals are checked against their lines; a mismatch is skipped.",
  "",
  "| Orders | Count |",
  "|---|---:|",
  "| read | 1284 |",
  "| imported | 1279 |",
  "| skipped | 5 |",
  "",
  "Run it again with `npm run import -- --dry-run` to see what would change.",
  "",
].join(NL));

emit(90, { type: "step.started", queue: "RF", step: "RF1" });
emit(60, { type: "review.added", queue: "RF", step: "RF1", round: 1, items: [
  { path: report, label: "Import report", kind: "data" },
  { path: plan, label: "Import plan", kind: "data" },
  { path: table, label: "Sample of the orders", kind: "data" },
  { path: notes, label: "Notes on the import", kind: "doc" },
] });
emit(58, { type: "check.result", queue: "RF", step: "RF1", name: "npm test", ok: true, summary: "88 passed" });
emit(55, { type: "step.done", queue: "RF", step: "RF1", summary: "Orders come in; five were skipped, each with its reason in the report." });
console.log(`seeded ${root}`);
