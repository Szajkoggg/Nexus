// Shared parts of the phone mockups: the top line and the bottom bar. Each page calls phoneChrome(active, counts).
const icons = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  waiting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 13l2-8h12l2 8v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/></svg>',
  queues: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
  ideas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/></svg>',
};
function phoneTop(project = "Nexus", extra = "") {
  return `<div class="row" style="height:52px; padding: 0 14px; border-bottom: 1px solid var(--border); background: var(--surface)">
    <span class="row gap-4" style="font-weight:600; font-size:16px">${project} <span class="faint" style="font-size:12px">▾</span></span>
    <span class="st running" style="font-size:12px; margin-left:6px">SF running</span>
    <span class="grow"></span>${extra}<span class="faint" style="font-size:18px; padding: 0 4px">⚙</span></div>`;
}
function phoneBar(active, waiting = 6) {
  const item = (k, label, badge) => `<div class="${k === active ? "on" : ""}">${icons[k]}${badge ? `<span class="count">${badge}</span>` : ""}<span>${label}</span></div>`;
  return `<nav class="bottombar">${item("chat", "Orchestrator")}${item("waiting", "Waiting", waiting)}${item("queues", "Queues")}${item("ideas", "Ideas")}</nav>`;
}
