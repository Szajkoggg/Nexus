// A seed for the capture tool: a conversation's model and effort (queue CM; docs/ux/conversation-settings.md), on the
// fixture of CM1's mockups. A test project "demo" (Demo app) whose Ideas conversations run on Codex at gpt-6, medium
// effort, with the notes folder docs/ideas. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to
// the development instance's; it writes only there. No process runs: the chats are the files.
//
// - "Conversation controls" and "Reply in progress" (Codex): their own gpt-6 at high effort, two messages each.
// - docs/ideas/chat-improvements.md: the note whose "Chat about this" opens an empty idea chat (queue IC).
//
// The instance needs FAKE_CODEX_MODELS for the model list of CM1's fixture (gpt-6: low to xhigh; gpt-6-luna: low,
// medium), and, for the reply in progress, FAKE_CHAT_SLOW_ALL with FAKE_CHAT_SLOW_MS: the view list's head says how.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, newId, writeRegistry, type ChatEntry, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-conversation-settings.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(join(root, "docs/ideas"), { recursive: true });
// 16 November, 10:00 local time: the labels read as the mockups' did.
const at = (min = 0) => new Date(2026, 10, 16, 10, min).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.updateProject((p) => ({ ...p, conversations: { ...p.conversations, runtime: "codex", model: "gpt-6", effort: "medium", notes_dir: "docs/ideas" } }));
st.writeTags({ protocol: 1, areas: [{ name: "dashboard", at: at() }], activities: [], renames: [], proposals: [], decisions: [] });

writeFileSync(join(root, "docs/ideas/chat-improvements.md"), [
  "# Chat improvements", "", "**Summary:** Make it easier to review and continue conversations.", "**Area:** dashboard", "",
  "## Decided", "", "### 2026-11-15", "", "- Conversations keep their history when they go on.", "",
  "## Open", "", "- Where should conversation settings live?", "",
].join("\n"));

const conversation = (title: string, min: number): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role: "conversation", runtime: "codex", native_id: null, title, cwd: root,
    launched_by: "nexus", created_at: at(min), model: "gpt-6", effort: "high" };
  st.writeSession(s);
  return s;
};
const chat = (s: SessionFile, from: ChatEntry["from"], text: string) => st.appendChat(s.id, { at: at(), from, text });
for (const [title, min] of [["Conversation controls", 0], ["Reply in progress", 1]] as const) {
  const s = conversation(title, min);
  chat(s, "user", "Where should the conversation settings live?");
  chat(s, "partner", "Put them near the chat title. Keep the controls folded so the thread and composer stay in view.");
}
console.log(`seeded ${root}`);
