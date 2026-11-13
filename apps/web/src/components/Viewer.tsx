// Review images in the app: full screen, fitted, two-finger zoom, swipe or buttons to the next and previous image.
// A picture with a "before" (src/review.ts pairPictures) is shown beside it (stacked when the screen is upright) or
// overlaid with a slider; the step's view puts the picture's mark and comments below (`footer`).
// The viewer is a layer in the history (nav.ts: "viewer:<index>"), so Back and Escape close it; moving to another
// image replaces its entry, so one Back always returns to the step.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ViewerImage { src: string; label: string; round?: number; before?: { src: string; label: string } }
type Mode = "after" | "both" | "overlay";

const MAX_ZOOM = 6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** How a one-finger drag at no zoom ends: a swipe to the next (-1 means previous) image, or nothing. */
export function swipeOf(dx: number, dy: number, width: number): -1 | 0 | 1 {
  if (Math.abs(dx) < Math.max(50, width * 0.12) || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

export function ImageViewer({ images, index, onIndex, onClose, footer }: {
  images: ViewerImage[]; index: number; onIndex: (i: number) => void; onClose: () => void;
  /** Below the picture: what the user can do with it (its mark, comments). */
  footer?: (index: number) => ReactNode;
}) {
  const img = images[index]!;
  const [mode, setMode] = useState<Mode>("both");
  const shown: Mode = img.before ? mode : "after";
  const prev = index > 0 ? () => onIndex(index - 1) : undefined;
  const next = index < images.length - 1 ? () => onIndex(index + 1) : undefined;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev?.();
      if (e.key === "ArrowRight") next?.();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const arrow = "absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-canvas/60 p-2.5 text-fg ring-1 ring-line-strong hover:bg-canvas/85";
  return createPortal(
    <div role="dialog" aria-label="Review image" className="fixed inset-0 z-[60] flex flex-col bg-canvas pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center gap-3 px-3 py-2 text-sm">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-fg">{img.label}</div>
          <div className="text-xs text-fg-2">{images.length > 1 ? `${index + 1} of ${images.length}` : "1 image"}{img.round ? ` · round ${img.round}` : ""}</div>
        </div>
        <a href={img.src} target="_blank" rel="noreferrer" className="shrink-0 rounded-md px-2 py-1.5 text-xs text-accent hover:bg-surface-3" title="Open the original file in a new tab">Original ↗</a>
        <button onClick={onClose} aria-label="Close" className="shrink-0 rounded-md p-1.5 text-fg-2 hover:bg-surface-3 hover:text-fg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      {img.before && (
        <div className="flex justify-center gap-1 px-3 pb-2" role="group" aria-label="Compare with the before">
          {([["after", "After"], ["both", "Before and after"], ["overlay", "Overlay"]] as const).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} aria-pressed={shown === m}
              className={`rounded-full px-3 py-1 text-xs ring-1 ${shown === m ? "bg-accent-strong text-on-accent ring-accent" : "text-fg ring-line-strong hover:bg-surface-3"}`}>{label}</button>
          ))}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {/* Keyed by the image: zoom and pan start fresh on each. */}
        {shown === "after" || !img.before
          ? <Stage key={index} src={img.src} alt={img.label} onSwipe={(d) => (d > 0 ? next : prev)?.()} />
          : <Compare key={`${index}-${shown}`} before={img.before} after={{ src: img.src, label: img.label }} mode={shown} />}
        {prev && <button onClick={prev} aria-label="Previous image" className={`${arrow} left-2`}><Chevron dir="left" /></button>}
        {next && <button onClick={next} aria-label="Next image" className={`${arrow} right-2`}><Chevron dir="right" /></button>}
      </div>
      {footer && <div className="scroll-thin max-h-[40%] shrink-0 overflow-y-auto border-t border-line-strong bg-canvas px-3 py-2">{footer(index)}</div>}
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
function Compare({ before, after, mode }: { before: { src: string; label: string }; after: { src: string; label: string }; mode: "both" | "overlay" }) {
  const [split, setSplit] = useState(50);
  const tag = "absolute left-2 top-2 rounded bg-canvas/70 px-1.5 py-0.5 text-[11px] text-fg";
  if (mode === "both") {
    return (
      <div className="absolute inset-0 flex flex-col gap-1 p-1 landscape:flex-row">
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
      <div className="relative min-h-0 flex-1 select-none overflow-hidden">
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
