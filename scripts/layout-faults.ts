// Measures a page's layout faults (scripts/capture/faults.ts): lines through boxes, overlapping boxes, text cut short,
// and counts where lines cross. The page is a file (served with its folder over http, so a mockup's own scripts and
// styles load; a query such as ?v=b is kept) or a URL (a development instance's dashboard, never port 4317).
//
//   node scripts/layout-faults.ts <file|url> [--width 1440] [--height 900] [--click <text>]... [--boxes <css>]
//     [--lines <css>] [--shot <png>] [--wait <ms>]
//
// --click presses a button by its text first (on the dashboard: "All queues of <project>" opens the Queues view), each
// followed by --wait milliseconds, as the measuring is.
// Boxes are [data-plan-card], [data-box] unless --boxes says otherwise; lines are [data-edge] unless --lines does (on
// the dashboard: "section[aria-label='The plan'] svg path"). --shot also takes the window's picture (fixed viewport, as
// `nexus help review` asks). A width under 492 px is shown in a frame of that size (scripts/capture/edge.ts).
// Exit code 0 without faults, 1 with faults, 2 for a wrong command line or a page that did not open.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { EdgeBrowser } from "./capture/edge.ts";
import { collector, describe, findFaults, type Page } from "./capture/faults.ts";
import { freePort } from "./capture/run.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    width: { type: "string", default: "1440" }, height: { type: "string" }, boxes: { type: "string", default: "[data-plan-card], [data-box]" },
    lines: { type: "string", default: "[data-edge]" }, shot: { type: "string" }, wait: { type: "string", default: "400" },
    click: { type: "string", multiple: true }, help: { type: "boolean", short: "h" },
  },
});
const usage = "node scripts/layout-faults.ts <file|url> [--width 1440] [--height 900] [--click <text>]... [--boxes <css>] [--lines <css>] [--shot <png>] [--wait <ms>]";
if (o.help || positionals.length !== 1) { console.log(usage); process.exit(o.help ? 0 : 2); }
const width = Number(o.width), height = Number(o.height ?? (width < 1024 ? 844 : 900));
if (!(width > 0 && height > 0)) { console.error(`layout-faults: a width and a height in pixels\n${usage}`); process.exit(2); }

const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
let server: Server | undefined;
let url = positionals[0]!;
if (!/^https?:\/\//.test(url)) {
  // A file: its folder over http on 127.0.0.1, nothing outside it.
  const [path, query] = url.split("?");
  const file = resolve(path!), folder = dirname(file);
  try { statSync(file); } catch { console.error(`layout-faults: no file ${file}`); process.exit(2); }
  server = createServer((req, res) => {
    const wanted = resolve(folder, `.${decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)}`);
    if (!wanted.startsWith(folder + sep)) { res.writeHead(403).end(); return; }
    let body: Buffer;
    try { body = readFileSync(wanted); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[extname(wanted)] ?? "application/octet-stream" }).end(body);
  });
  const port = await freePort(4390);
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
  url = `http://127.0.0.1:${port}/${file.slice(folder.length + 1)}${query ? `?${query}` : ""}`;
} else if (new URL(url).port === "4317") {
  console.error("layout-faults: not the live instance (port 4317)"); process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), "nexus-layout-faults-"));
let browser: EdgeBrowser | undefined, code = 0;
try {
  browser = await EdgeBrowser.launch(profile);
  await browser.open(url, width, height);
  const wait = () => new Promise((r) => setTimeout(r, Number(o.wait)));
  await wait();
  for (const c of o.click ?? []) {
    if (!(await browser.click(c))) throw new Error(`no button "${c}" on the page`);
    await wait();
  }
  const faults = findFaults(await browser.evaluate<Page>(collector(o.boxes, o.lines)));
  console.log(`layout faults of ${positionals[0]} at ${width}×${height}:`);
  for (const l of describe(faults)) console.log(`  ${l}`);
  if (o.shot) { await browser.shot(o.shot); console.log(`  picture: ${o.shot}`); }
  code = faults.through.length + faults.overlaps.length + faults.cut.length ? 1 : 0;
} catch (e) {
  console.error(`layout-faults: ${(e as Error).message}`); code = 2;
} finally {
  await browser?.close();
  server?.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(code);
