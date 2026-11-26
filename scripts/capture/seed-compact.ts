// A seed for the capture tool: a test project "demo" with Ideas conversations (queue CC3, Compact), for the open
// conversation's ⋯ menu and the chat's line after a compaction. Run by scripts/capture.ts as `node <this> <data dir>`
// with NEXUS_HOME set to the development instance's; it writes only there. No process runs: the chats are the files.
//
// - "Mining the cliffs" (Claude Code): a few messages back and forth.
// - "Water table" (Claude Code): a conversation compacted on request, its Nexus line, and the talk going on after it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, newId, writeRegistry, type ChatEntry, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-compact.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });

const conversation = (title: string, created: number): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "conversation", runtime: "claude", native_id: null, title, cwd: root, launched_by: "nexus", created_at: ago(created) };
  st.writeSession(s);
  return s;
};
const chat = (s: SessionFile, min: number, from: ChatEntry["from"], text: string) => st.appendChat(s.id, { at: ago(min), from, text });

const water = conversation("Water table", 300);
chat(water, 290, "user", "How fast should the water rise in the lower shafts?");
chat(water, 289, "partner", "One row per minute below the old river line is a good start: slow enough to read, fast enough that props matter. Above the line it should not rise at all, so the river line is something the player learns to find.");
chat(water, 200, "user", "And pumps?");
chat(water, 199, "partner", "Pumps buy time rather than stopping it: each pump holds two rows, and a pump needs wood to build, which is far. That keeps the choice between digging deeper and propping what is there.");
chat(water, 120, "nexus", "The conversation's context was compacted: 148,210 tokens of context became 21,904");
chat(water, 60, "user", "Where were we on pumps?");
chat(water, 59, "partner", "Each pump holds two rows of water and costs wood; we kept the river line as the place where the rise starts.");

const mining = conversation("Mining the cliffs", 120);
chat(mining, 110, "user", "Should the first shaft be dug by hand?");
chat(mining, 109, "partner", "Yes: digging the first shaft by hand teaches where ore sits and why the walls need props. Every later tool then only speeds up what the hand already knows.");
chat(mining, 30, "user", "What does the player see when a wall is about to give?");
chat(mining, 29, "partner", "Dust first, then small stones from the ceiling, a few seconds apart. A prop placed in that time holds; after the first large stone it is too late.");
console.log(`seeded ${root}`);
