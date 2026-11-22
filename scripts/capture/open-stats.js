// Opens the global Stats view at load, for the capture tool only (a view's `script:`, scripts/capture/views.ts): a
// route is a hash, and the Stats view is a layer opened by the query (?stats, apps/web/src/layers.ts navOf), so the
// query is set before the dashboard reads it. In the phone's parent page it changes only that page's address.
(() => {
  if (!new URLSearchParams(location.search).has("stats")) history.replaceState(history.state, "", `${location.pathname}?stats${location.hash}`);
})();
