// The file and commit endpoints (src/files.ts): a relative path is the project's, not the server's working folder's;
// nothing outside the allowed roots is served, through `..`, a link pointing out or a network path; everything served
// carries a sandboxing Content-Security-Policy; text over 1 MB is cut; a commit is looked up by a checked hash only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, writeRegistry } from "@nexus/protocol";
import { spawnServer } from "./helpers.ts";
import { COMMIT_HASH, FILE_CSP, MAX_TEXT, commitDetail, cutText, locate } from "../src/files.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test Person", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();

/** A project with a few files, a file outside it, and links from inside to outside (where the system allows them). */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "nexus-files-"));
  const root = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "docs", "notes.md"), "# Notes\n\nInside the project.\n");
  writeFileSync(join(outside, "secret.txt"), "not for the dashboard\n");
  // A directory junction needs no privilege on Windows; a file symlink may (then that case is skipped).
  symlinkSync(outside, join(root, "out-dir"), "junction");
  let fileLink = true;
  try { symlinkSync(join(outside, "secret.txt"), join(root, "secret-link.txt"), "file"); } catch { fileLink = false; }
  return { base, root, outside, fileLink };
}

test("locate: relative to the project, inside the roots only, no .., no links out, no network paths", () => {
  const { root, outside, fileLink } = fixture();
  const ok = (p: string) => { const r = locate(root, [root], p); assert.ok("real" in r, `${p}: ${JSON.stringify(r)}`); return r.real; };
  const refused = (p: string, status: number) => { const r = locate(root, [root], p); assert.ok("error" in r && r.status === status, `${p}: ${JSON.stringify(r)}`); };
  assert.match(ok("docs/notes.md"), /notes\.md$/);
  assert.match(ok("docs\\notes.md"), /notes\.md$/);
  assert.match(ok(join(root, "docs", "notes.md")), /notes\.md$/, "an absolute path inside");
  refused(join(outside, "secret.txt"), 403);
  refused("../outside/secret.txt", 403);
  refused("docs/../docs/notes.md", 403); // `..` is never followed, even when it would stay inside
  refused("out-dir/secret.txt", 403);
  if (fileLink) refused("secret-link.txt", 403);
  refused("\\\\server\\share\\x.txt", 403);
  refused("//server/share/x.txt", 403);
  refused("\\\\?\\C:\\Windows\\win.ini", 403);
  refused("docs/missing.md", 404);
  refused("", 400);
  refused("docs/notes.md\0.png", 400);
  // A second allowed root (a worktree, a session's folder) is served by its absolute path.
  assert.ok("real" in locate(root, [root, outside], join(outside, "secret.txt")));
});

test("cutText ends at a line end, or else at a whole UTF-8 character", () => {
  assert.equal(cutText(Buffer.from("one\ntwo\nthr")).toString(), "one\ntwo\n");
  assert.equal(cutText(Buffer.from("ab\u00e9", "utf8").subarray(0, 3)).toString(), "ab", "a two-byte é cut in half");
  assert.equal(cutText(Buffer.from("ab\u20ac", "utf8").subarray(0, 4)).toString(), "ab", "a three-byte € cut after two bytes");
  assert.equal(cutText(Buffer.from("ab\u20ac", "utf8")).toString(), "ab\u20ac", "whole");
});

test("commitDetail: by hash in a local repository, a bad or unknown hash is nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-commit-"));
  gitIn(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "pic.bin"), Buffer.from([0, 1, 2, 3]));
  gitIn(dir, "add", "a.txt", "pic.bin");
  gitIn(dir, "commit", "-q", "-m", "First commit", "-m", "Why it was made.");
  const sha = gitIn(dir, "rev-parse", "HEAD");
  const c = commitDetail(dir, sha.slice(0, 7));
  assert.ok(c);
  assert.equal(c.sha, sha);
  assert.equal(c.subject, "First commit");
  assert.equal(c.author, "Test Person");
  assert.match(c.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(c.files, [{ path: "a.txt", insertions: 2, deletions: 0 }, { path: "pic.bin", insertions: null, deletions: null }]);
  assert.equal(c.insertions, 2);
  assert.equal(commitDetail(dir, "0".repeat(40)), undefined, "unknown");
  assert.equal(commitDetail(dir, "HEAD"), undefined, "a ref is not a hash");
  assert.equal(commitDetail(dir, "--output=x"), undefined);
  const tree = gitIn(dir, "rev-parse", "HEAD^{tree}");
  assert.equal(commitDetail(dir, tree), undefined, "a tree is not a commit");
  for (const bad of ["abc", "ABCDEF1", "abcdefg", "a".repeat(41), "abcdef1 ", "-abcdef1"]) assert.ok(!COMMIT_HASH.test(bad), bad);
});

test("the endpoints: the project's paths, the CSP on every file, a cut large file, a commit by hash", async () => {
  const { base, root, outside, fileLink } = fixture();
  process.env.NEXUS_HOME = join(base, "home");
  gitIn(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "evil.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`);
  writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(root, "big.log"), "0123456789abcdef\n".repeat(Math.ceil((MAX_TEXT * 1.5) / 17)));
  writeFileSync(join(root, "code.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "data.bin"), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
  gitIn(root, "add", "docs/notes.md", "code.ts");
  gitIn(root, "commit", "-q", "-m", "Notes and code");
  const sha = gitIn(root, "rev-parse", "HEAD");
  ProjectStore.init(root, { id: "p", name: "P", root });
  writeRegistry({ protocol: 1, projects: [{ id: "p", root }] });
  const port = await freePort();
  const child = spawnServer({ NEXUS_PORT: String(port), NEXUS_LOG: "" });
  const url = `http://127.0.0.1:${port}`;
  const file = (path: string) => fetch(`${url}/api/projects/p/file?path=${encodeURIComponent(path)}`);
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/api/projects")).ok) break; } catch { /* not up yet */ } await sleep(100); }

    // Relative: the project's file, whatever the server's own working folder (the test's: the repository, with an AGENTS.md).
    let res = await file("docs/notes.md");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "# Notes\n\nInside the project.\n");
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(res.headers.get("content-security-policy"), FILE_CSP);
    assert.equal(res.headers.get("x-nexus-kind"), "text");
    assert.equal((await file("AGENTS.md")).status, 404, "not the server's working folder");
    res = await file("code.ts");
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", "source code is text");
    assert.equal(await res.text(), "export const x = 1;\n");

    // Refused: outside, .., a link out, a network path.
    assert.equal((await file(join(outside, "secret.txt"))).status, 403);
    assert.equal((await file("../outside/secret.txt")).status, 403);
    assert.equal((await file("out-dir/secret.txt")).status, 403);
    if (fileLink) assert.equal((await file("secret-link.txt")).status, 403);
    assert.equal((await file("\\\\127.0.0.1\\c$\\Windows\\win.ini")).status, 403);

    // An SVG with a script: still a picture, but sandboxed; HTML is plain text, sandboxed too.
    res = await file("evil.svg");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/svg+xml");
    assert.match(res.headers.get("content-security-policy") ?? "", /(^|; )sandbox($|;)/);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    res = await file("page.html");
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("content-security-policy"), FILE_CSP);

    // Large text is cut at a line end within 1 MB, and says so.
    res = await file("big.log");
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(res.headers.get("x-nexus-truncated"), "1");
    assert.ok(Number(res.headers.get("x-nexus-size")) > MAX_TEXT);
    assert.ok(body.length <= MAX_TEXT && body.length > MAX_TEXT - 20);
    assert.equal(body.at(-1), 0x0a);
    assert.equal((await file("docs/notes.md")).headers.get("x-nexus-truncated"), null);

    // Another binary: a download, never shown.
    res = await file("data.bin");
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(res.headers.get("content-disposition"), "attachment");
    assert.equal(res.headers.get("x-nexus-kind"), "binary");
    assert.ok(res.headers.get("content-security-policy"));

    // A commit by hash, short or whole; a bad hash refused before git sees it; an unknown one not found.
    res = await fetch(`${url}/api/projects/p/commits/${sha.slice(0, 8)}`);
    assert.equal(res.status, 200);
    const c = (await res.json()) as { sha: string; subject: string; author: string; files: { path: string }[] };
    assert.equal(c.sha, sha);
    assert.equal(c.subject, "Notes and code");
    assert.equal(c.author, "Test Person");
    assert.deepEqual(c.files.map((f) => f.path).sort(), ["code.ts", "docs/notes.md"]);
    assert.equal((await fetch(`${url}/api/projects/p/commits/${sha}`)).status, 200);
    for (const bad of ["HEAD", "abc", "ZZZZZZZ", encodeURIComponent("--output=x")]) {
      assert.equal((await fetch(`${url}/api/projects/p/commits/${bad}`)).status, 400, bad);
    }
    assert.equal((await fetch(`${url}/api/projects/p/commits/${"0".repeat(40)}`)).status, 404);
    assert.equal((await fetch(`${url}/api/projects/nope/commits/${sha}`)).status, 404);
    // Remote access stays closed: from elsewhere, without the token, nothing.
    assert.equal((await fetch(`${url}/api/projects/p/commits/${sha}`, { headers: { "x-forwarded-for": "100.64.0.7" } })).status, 401);
  } finally {
    child.kill();
  }
});
