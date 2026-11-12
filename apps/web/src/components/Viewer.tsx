// Review images in the app: full screen, fitted, two-finger zoom, swipe or buttons to the next and previous image.
// The viewer is a layer in the history (nav.ts: "viewer:<index>"), so Back and Escape close it; moving to another
// image replaces its entry, so one Back always returns to the step.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ViewerImage { src: string; label: string; round?: number }

const MAX_ZOOM = 6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** How a one-finger drag at no zoom ends: a swipe to the next (-1 means previous) image, or nothing. */
export function swipeOf(dx: number, dy: number, width: number): -1 | 0 | 1 {
  if (Math.abs(dx) < Math.max(50, width * 0.12) || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

export function ImageViewer({ images, index, onIndex, onClose }: {
  images: ViewerImage[]; index: number; onIndex: (i: number) => void; onClose: () => void;
}) {
  const img = images[index]!;
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
  const arrow = "absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2.5 text-zinc-100 ring-1 ring-white/15 hover:bg-black/70";
  return createPortal(
    <div role="dialog" aria-label="Review image" className="fixed inset-0 z-[60] flex flex-col bg-black pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center gap-3 px-3 py-2 text-sm">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-zinc-100">{img.label}</div>
          <div className="text-xs text-zinc-400">{images.length > 1 ? `${index + 1} of ${images.length}` : "1 image"}{img.round ? ` · round ${img.round}` : ""}</div>
        </div>
        <a href={img.src} target="_blank" rel="noreferrer" className="shrink-0 rounded-md px-2 py-1.5 text-xs text-sky-300 hover:bg-white/10" title="Open the original file in a new tab">Original ↗</a>
        <button onClick={onClose} aria-label="Close" className="shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-white/10 hover:text-white">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* Keyed by the image: zoom and pan start fresh on each. */}
        <Stage key={index} src={img.src} alt={img.label} onSwipe={(d) => (d > 0 ? next : prev)?.()} />
        {prev && <button onClick={prev} aria-label="Previous image" className={`${arrow} left-2`}><Chevron dir="left" /></button>}
        {next && <button onClick={next} aria-label="Next image" className={`${arrow} right-2`}><Chevron dir="right" /></button>}
      </div>
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
