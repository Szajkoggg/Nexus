// Pictures in chat messages reach each runtime as it needs them. The message carries the uploaded picture's absolute
// path on its own line (PROTOCOL.md, "Uploads"). Claude Code opens it from the path with Read, which its chat roles
// may use; Codex does not open a path from the text, so the adapter adds a localImage item beside it (both probed
// live, see codex.ts). Against the fake runtimes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import { input, uploadedPictures } from "../src/codex.ts";
import { WAIT_MS, until as waitUntil } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
process.env.NEXUS_CODEX = join(here, "fake-codex.ts");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-pictures-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_ARGS = join(root, "args.log");
  process.env.FAKE_LOG = join(root, "fake.log");
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const uploads = join(store.dir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const picture = join(uploads, "20261114-120000-abcdef0123.png").replaceAll("\\", "/");
  writeFileSync(picture, PNG);
  const engine = new Engine(store, () => {});
  const orchestrator = new Orchestrator(store, engine, () => {});
  const conversations = new Conversations(store, orchestrator, () => {});
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>) : []);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms);
  const stop = () => { conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); };
  return {
    root, store, uploads, picture, orchestrator, conversations, until, stop,
    args: () => lines(process.env.FAKE_ARGS!), received: () => lines(process.env.FAKE_LOG!),
  };
}

test("an uploaded picture is a line that is its absolute path under .nexus/uploads/, of a file that exists", () => {
  const { root, uploads, picture, stop } = setup();
  try {
    const back = picture.replaceAll("/", "\\");
    writeFileSync(join(uploads, "notes.txt"), "x");
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "a.png"), PNG);
    assert.deepEqual(uploadedPictures(`Look at this:\n${picture}`), [picture]);
    assert.deepEqual(uploadedPictures(`  ${back}  \r\nand that`), [back], "backslashes, spaces around, CRLF");
    assert.deepEqual(uploadedPictures(`${picture}\n${picture}`), [picture], "once each");
    assert.deepEqual(uploadedPictures(`see ${picture} here`), [], "a path inside a sentence is not an attachment");
    assert.deepEqual(uploadedPictures(join(uploads, "gone.png")), [], "a file that is not there");
    assert.deepEqual(uploadedPictures(join(uploads, "notes.txt")), [], "not a picture");
    assert.deepEqual(uploadedPictures(join(root, "notes", "a.png")), [], "not under .nexus/uploads/");
    assert.deepEqual(uploadedPictures(".nexus/uploads/20261114-120000-abcdef0123.png"), [], "not absolute");
    assert.deepEqual(input(`Look:\n${picture}`), [
      { type: "text", text: `Look:\n${picture}`, text_elements: [] },
      { type: "localImage", path: picture },
    ], "Codex gets the text whole and the picture beside it");
    assert.deepEqual(input("Hello"), [{ type: "text", text: "Hello", text_elements: [] }]);
  } finally { stop(); }
});

test("a Codex partner gets an uploaded picture as a localImage item, with its path still in the text", async () => {
  const { conversations, picture, uploads, args, received, until, stop } = setup();
  try {
    const c = conversations.create({ title: "Look", runtime: "codex" });
    conversations.say(c.id, `What do you think of this screen?\n${picture}`);
    await until("the reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner"));
    assert.deepEqual(args().filter((a) => a.method === "turn/start").map((a) => a.images), [[picture]]);
    assert.ok(received().some((r) => String(r.text).split("\n").includes(picture)), "the path stays in the text");
    // A path whose file is gone adds no item (Codex would only tell the model it is missing): the message goes as text.
    const gone = join(uploads, "20261114-120001-0000000000.png").replaceAll("\\", "/");
    conversations.say(c.id, `And this one?\n${gone}`);
    await until("the second reply", () => conversations.view(c.id).chat.filter((x) => x.from === "partner").length === 2);
    assert.deepEqual(args().filter((a) => a.method === "turn/start").map((a) => a.images), [[picture], []]);
  } finally { stop(); }
});

test("a Claude partner and the orchestrator get the picture's path on its own line, which they open with Read", async () => {
  const { conversations, orchestrator, picture, args, received, until, stop } = setup();
  try {
    const c = conversations.create({ title: "Look" });
    conversations.say(c.id, `What do you think of this screen?\n${picture}`);
    await until("the partner's reply", () => conversations.view(c.id).chat.some((x) => x.from === "partner"));
    orchestrator.say(`Make the header like this:\n${picture}`);
    await until("the orchestrator's reply", () => orchestrator.view().chat.some((x) => x.from === "orchestrator"));
    const texts = received().map((r) => String(r.text));
    assert.equal(texts.filter((t) => t.split("\n").includes(picture)).length, 2, "both messages carry the path on its own line");
    // Both roles may Read anywhere (their allow lists start with a bare Read), so the picture opens without asking.
    const starts = args().filter((x) => Array.isArray(x.argv));
    assert.equal(starts.length, 2, "the partner's and the orchestrator's starts");
    for (const a of starts) {
      const argv = a.argv as string[];
      assert.ok(argv.slice(argv.indexOf("--allowedTools") + 1).includes("Read"), "Read is allowed");
      assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
    }
  } finally { stop(); }
});
