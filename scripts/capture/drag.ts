// The capture tool's drag (views.ts, action `drag`): HTML5 drag and drop as the dashboard's plan view takes it
// (components/Plan.tsx: dragstart on a queue, dragenter and dragover on the target, which may split into halves, then
// drop). The browser cannot be driven to a native drag in a headless window, so the page gets the events themselves,
// with one DataTransfer through all of them, each at its element's middle. A short pause after each lets the page
// draw what the last one changed (the halves of a target appear on its first dragover). Without `drop` the page stays
// in the middle of the drag, for a picture of it.

/** The drag as an expression for the page: true once done, false when an element is not there. */
export function dragScript(from: string, to: readonly string[], drop: boolean, pauseMs = 120): string {
  return `(async () => {
    const pause = () => new Promise((r) => setTimeout(r, ${pauseMs}));
    const source = document.querySelector(${JSON.stringify(from)});
    if (!source) return false;
    const data = new DataTransfer();
    const fire = (el, type) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: data, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    };
    source.scrollIntoView({ block: "nearest" });
    fire(source, "dragstart");
    await pause();
    let last;
    for (const selector of ${JSON.stringify(to)}) {
      const el = document.querySelector(selector);
      if (!el) return false;
      fire(el, "dragenter");
      fire(el, "dragover");
      last = el;
      await pause();
    }
    if (${drop}) {
      fire(last, "drop");
      fire(source, "dragend");
      await pause();
    }
    return true;
  })()`;
}
