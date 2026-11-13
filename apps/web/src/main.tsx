import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { pruneStoredDrafts } from "./drafts.ts";
import { applyTheme, watchTheme } from "./theme.ts";

pruneStoredDrafts();
applyTheme();
watchTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker carries push notifications. Browsers allow it on https and on localhost only.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* notifications stay in-tab */ });
}
