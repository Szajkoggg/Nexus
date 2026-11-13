// Review images in the app: full screen, fitted, two-finger zoom, swipe or buttons to the next and previous image.
// A picture with a "before" (src/review.ts pairPictures) is shown beside it (stacked when the screen is upright) or
// overlaid with a slider; the step's view puts its action bar below (`footer`: the picture's mark, comments, and
// the original file under ⋯).
// The viewer is a layer in the history (nav.ts: "viewer:<index>"), so Back and Escape close it; moving to another
// image replaces its entry, so one Back always returns to the step.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ViewerImage {
  src: string; label: string; round?: number; before?: { src: string; label: string };
  /** The user's mark and comments on it, shown on its thumbnail in the filmstrip. */
  accepted?: boolean; comments?: number;
}
type Mode = "after" | "both" | "overlay";

const MAX_ZOOM = 6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** How a one-finger drag at no zoom ends: a swipe to the next (-1 means previous) image, or nothing. */
export function swipeOf(dx: number, dy: number, width: number): -1 | 0 | 1 {
  if (Math.abs(dx) < Math.max(50, width * 0.12) || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

export function ImageViewer({ images, index, onIndex, onClose, footer, back, context }: {
  images: ViewerImage[]; index: number; onIndex: (i: number) => void; onClose: () => void;
  /** What ‹ goes back to (the step's id), and where the pictures are ("Nexus · UX · UX2 Proposals…"). */
  back?: string; context?: string;
  /** Below the picture: an ActionBar with what the user can do with it (its mark, comments, the original). */
  footer?: (index: number) => ReactNode;
}) {
  const img = images[index]!;
  const [mode, setMode] = useState<Mode>("both");
  const shown: Mode = img.before ? mode : "after";
  const prev = index > 0 ? () => onIndex(index - 1) : undefined;
  const next = index < images.length - 1 ? () => onIndex(index + 1) : undefined;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") prev?.();
      if (e.key === "ArrowRight") next?.();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const arrow = "absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-canvas/60 p-2.5 text-fg ring-1 ring-line-strong hover:bg-canvas/85";
  // The filmstrip keeps the picture shown in sight.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => { strip.current?.querySelector("[aria-current=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [index]);
  const marked = images.filter((x) => x.accepted).length;
  return createPortal(
    <div role="dialog" aria-label="Review image" className="fixed inset-0 z-[60] flex flex-col bg-canvas pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2 text-sm">
        {back && (
          <button onClick={onClose} aria-label={`Back to ${back}`} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:min-h-11">
            <Chevron dir="left" /><span className="font-mono text-xs">{back}</span>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-fg">{img.label}</div>
          <div className="truncate text-xs text-fg-3">
            {images.length > 1 ? `picture ${index + 1} of ${images.length}` : "1 picture"}{img.round ? ` · round ${img.round}` : ""}{context ? ` · ${context}` : ""}
          </div>
        </div>
        {img.before && (
          <div className="flex shrink-0 gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5 max-lg:order-last max-lg:basis-full max-lg:justify-center" role="group" aria-label="Compare with the before">
            {([["after", "After"], ["both", "Before | After"], ["overlay", "Overlay"]] as const).map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)} aria-pressed={shown === m}
                className={`rounded-md px-3 py-1 text-xs max-lg:min-h-9 ${shown === m ? "bg-surface-4 font-semibold text-fg" : "text-fg-2 hover:text-fg"}`}>{label}</button>
            ))}
          </div>
        )}
        {!footer && <a href={img.src} target="_blank" rel="noreferrer" className="shrink-0 rounded-md px-2 py-1.5 text-xs text-accent hover:bg-surface-3" title="Open the original file in a new tab">Original ↗</a>}
        <button onClick={onClose} aria-label="Close" className="grid shrink-0 place-items-center rounded-md p-1.5 text-fg-2 hover:bg-surface-3 hover:text-fg max-lg:h-11 max-lg:w-11">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* Keyed by the image: zoom and pan start fresh on each. */}
        {shown === "after" || !img.before
          ? <Stage key={index} src={img.src} alt={img.label} onSwipe={(d) => (d > 0 ? next : prev)?.()} />
          : <Compare key={`${index}-${shown}`} before={img.before} after={{ src: img.src, label: img.label }} mode={shown} onSwipe={(d) => (d > 0 ? next : prev)?.()} />}
        {prev && <button onClick={prev} aria-label="Previous image" className={`${arrow} left-2`}><Chevron dir="left" /></button>}
        {next && <button onClick={next} aria-label="Next image" className={`${arrow} right-2`}><Chevron dir="right" /></button>}
      </div>
      {images.length > 1 && (
        <div className="flex items-center gap-3 border-t border-line bg-surface px-3 py-2">
          <div ref={strip} className="scroll-thin flex min-w-0 gap-2 overflow-x-auto" role="list" aria-label="The step's pictures">
            {images.map((x, i) => (
              <button key={i} role="listitem" onClick={() => onIndex(i)} aria-current={i === index} title={x.label}
                className={`relative h-12 w-20 shrink-0 overflow-hidden rounded-md border-2 bg-canvas lg:h-16 lg:w-28 ${i === index ? "border-accent" : "border-transparent opacity-80 hover:opacity-100"}`}>
                <img src={x.src} alt={x.label} draggable={false} className="h-full w-full object-cover object-left-top" loading="lazy" />
                {x.accepted && <span className="absolute right-1 top-1 rounded bg-ok px-1 text-[11px] font-bold leading-4 text-canvas" title="Marked">✓</span>}
                {!!x.comments && <span className="absolute bottom-1 right-1 rounded bg-canvas/80 px-1 text-[10px] leading-4 text-info" title="Your comments">💬 {x.comments}</span>}
              </button>
            ))}
          </div>
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-fg-3">{marked} of {images.length} marked<span className="max-lg:hidden"> · ← → to move</span></span>
        </div>
      )}
      {footer?.(index)}
    </div>,
    document.body,
  );
}

const Chevron = ({ dir }: { dir: "left" | "right" }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
  </svg>
);

/** The image and its gestures: pinch to zoom, drag to pan when zoomed, swipe when not, double-tap to zoom in or out. */
function Stage({ src, alt, onSwipe }: { src: string; alt: string; onSwipe: (dir: -1 | 1) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const points = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ x: number; y: number; tx: number; ty: number; s: number; d0?: number; pinched: boolean; dy: number } | undefined>(undefined);
  const [z, setZ] = useState({ s: 1, tx: 0, ty: 0 });
  const [drag, setDrag] = useState(0);
  const [moving, setMoving] = useState(false);

  const down = (e: React.PointerEvent) => {
    box.current?.setPointerCapture(e.pointerId);
    points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...points.current.values()];
    if (pts.length === 1) start.current = { x: e.clientX, y: e.clientY, tx: z.tx, ty: z.ty, s: z.s, pinched: false, dy: 0 };
    else if (pts.length === 2 && start.current) { start.current = { ...start.current, d0: dist(pts[0]!, pts[1]!), s: z.s, pinched: true }; setDrag(0); }
    setMoving(true);
  };
  const move = (e: React.PointerEvent) => {
    if (!points.current.has(e.pointerId) || !start.current) return;
    points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = start.current;
    const pts = [...points.current.values()];
    if (pts.length >= 2 && g.d0) {
      const s = clamp(g.s * (dist(pts[0]!, pts[1]!) / g.d0), 1, MAX_ZOOM);
      setZ((v) => ({ ...v, s }));
    } else if (pts.length === 1 && !g.pinched) {
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      g.dy = dy;
      if (z.s > 1) setZ((v) => ({ ...v, tx: g.tx + dx, ty: g.ty + dy }));
      else setDrag(dx);
    }
  };
  const up = (e: React.PointerEvent) => {
    points.current.delete(e.pointerId);
    if (points.current.size > 0) return;
    const g = start.current;
    start.current = undefined;
    setMoving(false);
    if (g && !g.pinched && z.s <= 1) {
      const d = swipeOf(drag, g.dy, box.current?.clientWidth ?? 0);
      setDrag(0);
      if (d) onSwipe(d);
    }
    if (z.s <= 1.02) setZ({ s: 1, tx: 0, ty: 0 });
  };

  return (
    <div
      ref={box}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={() => setZ((v) => (v.s > 1 ? { s: 1, tx: 0, ty: 0 } : { s: 2.5, tx: 0, ty: 0 }))}
      className="absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden"
    >
      <img
        src={src} alt={alt} draggable={false}
        className={`max-h-full max-w-full object-contain ${moving ? "" : "transition-transform duration-150"}`}
        style={{ transform: `translate(${z.tx + drag}px, ${z.ty}px) scale(${z.s})` }}
      />
    </div>
  );
}

/** A picture and its before: both (beside each other, stacked when upright) or overlaid with a slider to wipe between. */
function Compare({ before, after, mode, onSwipe }: { before: { src: string; label: string }; after: { src: string; label: string }; mode: "both" | "overlay"; onSwipe: (dir: -1 | 1) => void }) {
  const [split, setSplit] = useState(50);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const swipe = {
    onPointerDown: (e: React.PointerEvent) => { if ((e.target as HTMLElement).tagName !== "INPUT") start.current = { x: e.clientX, y: e.clientY }; },
    onPointerUp: (e: React.PointerEvent) => {
      const s = start.current; start.current = undefined;
      if (!s) return;
      const d = swipeOf(e.clientX - s.x, e.clientY - s.y, (e.currentTarget as HTMLElement).clientWidth);
      if (d) onSwipe(d);
    },
    onPointerCancel: () => { start.current = undefined; },
  };
  const tag = "absolute left-2 top-2 rounded bg-canvas/70 px-1.5 py-0.5 text-[11px] text-fg";
  if (mode === "both") {
    return (
      <div {...swipe} className="absolute inset-0 flex touch-pan-y flex-col gap-1 p-1 landscape:flex-row">
        {[["Before", before], ["After", after]].map(([what, x]) => {
          const p = x as { src: string; label: string };
          return (
            <figure key={what as string} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded bg-canvas">
              <img src={p.src} alt={`${what as string}: ${p.label}`} draggable={false} className="max-h-full max-w-full object-contain" />
              <figcaption className={tag}>{what as string} · {p.label}</figcaption>
            </figure>
          );
        })}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col">
      <div {...swipe} className="relative min-h-0 flex-1 touch-pan-y select-none overflow-hidden">
        <img src={before.src} alt={`Before: ${before.label}`} draggable={false} className="absolute inset-0 m-auto max-h-full max-w-full object-contain" />
        <img src={after.src} alt={`After: ${after.label}`} draggable={false} className="absolute inset-0 m-auto max-h-full max-w-full object-contain" style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
        <div className="pointer-events-none absolute inset-y-0 w-px bg-accent/80" style={{ left: `${split}%` }} />
        <span className={tag}>Before · {before.label}</span>
        <span className="absolute right-2 top-2 rounded bg-canvas/70 px-1.5 py-0.5 text-[11px] text-fg">After</span>
      </div>
      <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="Before and after split" className="mx-4 my-2 accent-accent" />
    </div>
  );
}
