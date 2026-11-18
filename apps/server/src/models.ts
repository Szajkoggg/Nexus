// The models each runtime offers, asked from the runtime itself, so the dashboard lists real names (and never
// offers a typo). Claude Code answers an `initialize` control request on its stream-json input with its models;
// Codex answers `model/list` on the app-server. Kept for an hour; a fixed list stands in if a runtime does not answer.
import { spawn } from "node:child_process";
import type { ModelInfo } from "@nexus/protocol";


const cache = new Map<string, { at: number; models: ModelInfo[] }>();
const FALLBACK: Record<"claude" | "codex", ModelInfo[]> = {
  claude: [{ value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }, { value: "haiku", label: "Haiku" }],
  codex: [],
};

export async function listModels(runtime: "claude" | "codex"): Promise<ModelInfo[]> {
  const hit = cache.get(runtime);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.models;
  const models = await (runtime === "claude" ? askClaude() : askCodex()).catch(() => []);
  if (models.length) cache.set(runtime, { at: Date.now(), models });
  return models.length ? models : FALLBACK[runtime];
}

/**
 * Runs a runtime's process, writes the given lines, and resolves with the first answer `pick` accepts. A process that
 * cannot start, exits before it answers or does not answer in time resolves with no models (the caller's fixed list).
 */
function ask(bin: string, args: string[], lines: unknown[], pick: (msg: Record<string, any>, write: (m: unknown) => void) => ModelInfo[] | undefined): Promise<ModelInfo[]> {
  const script = /\.(m?[jt]s)$/.test(bin);
  const proc = spawn(script ? process.execPath : bin, script ? [bin, ...args] : args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  return new Promise<ModelInfo[]>((resolve) => {
    let buffer = "";
    let settled = false;
    const done = (m: ModelInfo[]) => { if (settled) return; settled = true; clearTimeout(timer); proc.kill(); resolve(m); };
    const timer = setTimeout(() => done([]), 20_000);
    // A process that exits (or is killed) while lines are on their way fails the write with EPIPE: an error event
    // nobody listened to would end the server. Its exit settles the answer; the write is moot.
    proc.stdin.on("error", () => {});
    const write = (m: unknown) => { if (!settled && proc.stdin.writable) proc.stdin.write(JSON.stringify(m) + "\n"); };
    proc.on("error", () => done([]));
    // Its output is read to the end before "close": an answer written just before the exit still counts.
    proc.on("close", () => done([]));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => {
      buffer += d;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { const r = pick(JSON.parse(line) as Record<string, any>, write); if (r) return done(r); } catch { /* not a message */ }
      }
    });
    for (const l of lines) write(l);
  });
}

function askClaude(): Promise<ModelInfo[]> {
  return ask(process.env.NEXUS_CLAUDE ?? "claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    [{ type: "control_request", request_id: "nexus-models", request: { subtype: "initialize" } }],
    (m) => {
      if (m.type !== "control_response") return undefined;
      const list = ((m.response?.response ?? m.response)?.models ?? []) as Record<string, any>[];
      return list.filter((x) => x.value && x.value !== "default").map((x) => ({
        value: x.value as string, label: (x.displayName as string) ?? x.value, description: x.description as string | undefined,
        efforts: x.supportedEffortLevels as string[] | undefined,
      }));
    });
}

function askCodex(): Promise<ModelInfo[]> {
  return ask(process.env.NEXUS_CODEX ?? "codex", ["app-server"],
    [{ id: 1, method: "initialize", params: { clientInfo: { name: "nexus", title: "Nexus", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } } }],
    (m, write) => {
      if (m.id === 1) { write({ method: "initialized", params: {} }); write({ id: 2, method: "model/list", params: {} }); return undefined; }
      if (m.id !== 2) return undefined;
      const list = (m.result?.data ?? []) as Record<string, any>[];
      return list.filter((x) => !x.hidden).map((x) => ({
        value: (x.model ?? x.id) as string, label: (x.displayName as string) || (x.model ?? x.id), description: x.description as string | undefined,
        efforts: (x.supportedReasoningEfforts as unknown[] | undefined)?.map((e) => (typeof e === "string" ? e : (e as { reasoningEffort?: string }).reasoningEffort ?? "")).filter(Boolean),
      }));
    });
}
