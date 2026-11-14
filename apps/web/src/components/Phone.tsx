// The phone layout's own parts (below 1024 px): the top line and the bottom bar with its four tabs. What each tab
// shows, and the sheets over them, are in App; the routing (tabs add no history entry) is in layers.ts.
import type { ReactNode } from "react";
import type { Tab } from "../layers.ts";
import type { QueueView } from "../api.ts";
import { t, type Key } from "../i18n.ts";

/** What runs in the project, for the top line: "SF running", "SF, SC running"; nothing when nothing runs. */
export function RunningNow({ queues }: { queues: QueueView[] }) {
  const ids = queues.filter((q) => q.run?.state === "running").map((q) => q.id);
  if (!ids.length) return null;
  const shown = ids.length > 2 ? `${ids.slice(0, 2).join(", ")} +${ids.length - 2}` : ids.join(", ");
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5 text-xs font-medium text-accent" title={t("phone.runningTitle", { ids: ids.join(", ") })}>
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span className="truncate">{t("phone.running", { ids: shown })}</span>
    </span>
  );
}

const ICONS: Record<Tab, ReactNode> = {
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  waiting: <><path d="M4 13l2-8h12l2 8v6H4z" /><path d="M4 13h5l1 2h4l1-2h5" /></>,
  queues: <path d="M5 6h14M5 12h14M5 18h9" />,
  ideas: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" />,
};
const LABELS: Record<Tab, Key> = { chat: "phone.tab.chat", waiting: "phone.tab.waiting", queues: "phone.tab.queues", ideas: "phone.tab.ideas" };
const ORDER: Tab[] = ["chat", "waiting", "queues", "ideas"];

/**
 * The bottom bar: Orchestrator, Waiting (with what waits in all projects), Queues, Ideas. One tap switches; the tab
 * shown is marked. A dot on Orchestrator while it works.
 */
export function BottomBar({ tab, waiting, working, unread, onTab }: {
  tab: Tab; waiting: number; working: boolean;
  /** Unread in the chats (chatPlace.ts): a count on Orchestrator, a dot on Ideas. */
  unread: { chat: number; ideas: boolean };
  onTab: (t: Tab) => void;
}) {
  return (
    <nav aria-label={t("phone.tabs")} className="grid shrink-0 grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
      {ORDER.map((x) => (
        <button key={x} onClick={() => onTab(x)} aria-current={x === tab ? "page" : undefined}
          className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${x === tab ? "text-fg" : "text-fg-3 hover:text-fg-2"}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">{ICONS[x]}</svg>
          <span className={x === tab ? "font-semibold" : ""}>{t(LABELS[x])}</span>
          {x === "waiting" && waiting > 0 && (
            <span className="absolute left-[calc(50%+4px)] top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-warn px-1 text-[11px] font-semibold text-canvas">{waiting}</span>
          )}
          {x === "chat" && unread.chat > 0 && (
            <span className="absolute left-[calc(50%+4px)] top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent-strong px-1 text-[11px] font-semibold text-on-accent" aria-label={t("common.newCount", { count: unread.chat })}>{unread.chat}</span>
          )}
          {x === "chat" && working && !unread.chat && <span className="absolute left-[calc(50%+8px)] top-2.5 h-2 w-2 animate-pulse rounded-full bg-accent" title={t("phone.orchestratorWorking")} />}
          {x === "ideas" && unread.ideas && <span className="absolute left-[calc(50%+8px)] top-2.5 h-2 w-2 rounded-full bg-accent" aria-label={t("common.newMessages")} />}
        </button>
      ))}
    </nav>
  );
}
