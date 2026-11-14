// The project's rules files on its page: a warning when a runtime would not see the project's rules (AGENTS.md,
// pulled into CLAUDE.md with @AGENTS.md, is Nexus's convention), and the fix, which shows the change to the files
// before the user makes it. The server writes the files and commits nothing (apps/server/src/rulesfix.ts).
import { useState } from "react";
import type { RulesCheck, RulesFileChange } from "@nexus/protocol/rules";
import { actResult, enc, useFetch, type ProjectState } from "../api.ts";
import { Button } from "./ui.tsx";
import { rich, t, type Key } from "../i18n.ts";

interface ProjectRules extends RulesCheck { version: string; root: string }

const RUNTIME = { claude: "Claude Code", codex: "Codex" } as const;
const WHY: Record<"only-agents" | "only-claude" | "unlinked", Key> = {
  "only-agents": "rules.why.onlyAgents",
  "only-claude": "rules.why.onlyClaude",
  unlinked: "rules.why.unlinked",
};
const FIX: Record<"only-agents" | "only-claude" | "unlinked", Key> = {
  "only-agents": "rules.fix.onlyAgents",
  "only-claude": "rules.fix.onlyClaude",
  unlinked: "rules.fix.unlinked",
};

const code = (text: string, key = text) => <code key={key} className="font-mono text-[0.95em]">{text}</code>;

/** The warning, with its fix: nothing when both runtimes see the rules (or there are none). */
export function RulesWarning({ project }: { project: ProjectState }) {
  const id = project.project.id;
  const [tick, setTick] = useState(0);
  const rules = useFetch<ProjectRules>(`/api/projects/${enc(id)}/rules`, `${project.generated_at}/${tick}`);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  if (msg?.ok) {
    return <div className="mb-4 rounded-lg border border-ok/30 bg-ok/5 px-4 py-3 text-sm text-ok">{t("rules.done", { what: msg.text })}</div>;
  }
  if (!rules || !rules.fix || !rules.unseen_by || rules.state === "linked" || rules.state === "neither") return null;
  const state = rules.state;
  const make = async () => {
    setBusy(true); setMsg(undefined);
    try {
      const r = await actResult<{ message: string }>(id, "POST", "/rules/fix", { version: rules.version });
      setMsg({ ok: true, text: r?.message ?? "" });
      setOpen(false);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); setTick((x) => x + 1); }
    finally { setBusy(false); }
  };
  return (
    <section className="mb-4 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm" aria-label={t("rules.label")}>
      <div className="font-medium text-warn">{t("rules.unseen", { runtime: RUNTIME[rules.unseen_by] })}</div>
      <p className="mt-1 text-xs text-fg-2">{rich(WHY[state], { agents: code("AGENTS.md"), claude: code("CLAUDE.md") })}</p>
      <p className="mt-1 text-xs text-fg-3">{rich("rules.convention", { link: code("@AGENTS.md") })}</p>
      {!open && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="quiet" onClick={() => { setMsg(undefined); setOpen(true); }}>{t("rules.showFix")}</Button>
          {msg && !msg.ok && <span className="text-xs text-danger">{msg.text}</span>}
        </div>
      )}
      {open && (
        <div className="mt-3 rounded-lg border border-line bg-surface p-3">
          <div className="text-sm font-medium text-fg">{t("rules.fixTitle")}</div>
          <p className="mt-1 text-xs text-fg-2">{rich(FIX[state], { agents: code("AGENTS.md"), claude: code("CLAUDE.md"), link: code("@AGENTS.md") })}</p>
          <div className="mt-3 space-y-3">
            {rules.fix.changes.map((c) => <Change key={c.file} change={c} />)}
          </div>
          {rules.fix.imports.length > 0 && (
            <p className="mt-3 rounded-md border border-warn/30 bg-warn/5 px-2 py-1.5 text-xs text-warn">
              {rich("rules.imports", { list: <span key="list" className="font-mono">{rules.fix.imports.join(", ")}</span> })}
            </p>
          )}
          <p className="mt-3 text-xs text-fg-3">{rich("rules.noCommit", { root: code(rules.root) })}</p>
          {msg && !msg.ok && <p className="mt-2 text-xs text-danger">{msg.text}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void make()}>{busy ? t("ui.sending") : t("rules.make")}</Button>
            <Button variant="quiet" disabled={busy} onClick={() => { setOpen(false); setMsg(undefined); }}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The lines of a text, each without its line ending; a final ending makes no empty last line. */
const linesOf = (text: string) => text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l, i, all) => i < all.length - 1 || l !== "");

/** One file's change: a new file's whole text, or a changed file's lines removed and added (with a little context). */
function Change({ change }: { change: RulesFileChange }) {
  const after = linesOf(change.after);
  const before = change.before === undefined ? undefined : linesOf(change.before);
  let rows: { sign: " " | "+" | "-"; text: string }[];
  if (!before) rows = after.map((text) => ({ sign: "+", text }));
  else {
    let p = 0; while (p < before.length && p < after.length && before[p] === after[p]) p++;
    let s = 0; while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
    const CONTEXT = 3;
    rows = [
      ...before.slice(Math.max(0, p - CONTEXT), p).map((text) => ({ sign: " " as const, text })),
      ...before.slice(p, before.length - s).map((text) => ({ sign: "-" as const, text })),
      ...after.slice(p, after.length - s).map((text) => ({ sign: "+" as const, text })),
      ...before.slice(before.length - s, Math.min(before.length, before.length - s + CONTEXT)).map((text) => ({ sign: " " as const, text })),
    ];
  }
  const eol = (change.before ?? change.after).includes("\r\n") ? "CRLF" : "LF";
  const bom = (change.before ?? change.after).startsWith("\uFEFF");
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-mono font-medium text-fg">{change.file}</span>
        <span className="text-fg-3">{change.action === "create" ? t("rules.newFile") : t("rules.changed")}</span>
        <span className="text-fg-3">· {t(bom ? "rules.eolBom" : "rules.eol", { eol })}</span>
      </div>
      <pre className="scroll-thin max-h-56 overflow-auto rounded-md border border-line bg-canvas py-1.5 font-mono text-xs leading-5">
        {rows.map((r, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all px-2 ${r.sign === "+" ? "bg-ok/10 text-ok" : r.sign === "-" ? "bg-danger/10 text-danger" : "text-fg-3"}`}>
            <span className="select-none pr-2">{r.sign}</span>{r.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
