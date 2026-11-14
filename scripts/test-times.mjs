// A test reporter: how long each test file took, slowest first (queue TS2). A file's time is the sum of its top-level
// tests' (they run one after another within a file); the files themselves run side by side.
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./scripts/test-times.mjs --test-reporter-destination=<file> <test files>
//
// `npm run test:times` runs the whole suite and prints the list after the usual output.
import { relative } from "node:path";

export default async function* times(source) {
  const files = new Map();
  let total = 0;
  for await (const e of source) {
    if ((e.type === "test:pass" || e.type === "test:fail") && e.data.nesting === 0 && e.data.file) {
      const ms = e.data.details?.duration_ms ?? 0;
      files.set(e.data.file, (files.get(e.data.file) ?? 0) + ms);
    }
    if (e.type === "test:summary" && e.data.file === undefined) total = e.data.duration_ms ?? total;
  }
  const rows = [...files].sort((a, b) => b[1] - a[1]);
  yield `${rows.length} files; the whole run took ${(total / 1000).toFixed(1)} s\n`;
  for (const [file, ms] of rows) yield `${(ms / 1000).toFixed(1).padStart(7)} s  ${relative(process.cwd(), file).replaceAll("\\", "/")}\n`;
}
