// A queue's steps as a list (UX proposals, 17B): on the phone the list folds what does not matter now. Pure and unit
// tested; QueueRow.tsx draws it.

/** Finished steps: what a folded run of them is made of. */
const FINISHED = new Set(["done", "skipped"]);

/** The step that matters in a queue: its current one (at work, or the stop), else the first not finished. */
export function currentIndex(steps: readonly { id: string; status: string }[], current?: string): number {
  const i = current ? steps.findIndex((s) => s.id === current) : -1;
  if (i >= 0) return i;
  const open = steps.findIndex((s) => !FINISHED.has(s.status));
  return open < 0 ? steps.length : open;
}

export interface Folded<T> {
  /** The finished run before the step that matters, folded into one line: its first and last step and its counts. */
  before?: { from: string; to: string; count: number; done: number; skipped: number };
  /** The steps shown, one line each. */
  shown: T[];
  /** The steps after the shown ones, folded into one line ("+ W6, W7"). */
  after?: string[];
}

/**
 * Folds a queue's steps for the phone: the finished run before the step that matters (the leading done and skipped
 * steps) becomes one line, and so do the steps after the third that follow it. A fold of a single step would save
 * nothing, so it is shown instead. `open` unfolds either part (the user tapped it). With every step finished, the
 * whole queue is the finished run.
 */
export function foldSteps<T extends { id: string; status: string }>(
  steps: readonly T[], current?: string, open: { before?: boolean; after?: boolean } = {}, following = 3,
): Folded<T> {
  const c = currentIndex(steps, current);
  let k = 0;
  while (k < c && FINISHED.has(steps[k]!.status)) k++;
  const foldBefore = k >= 2 && !open.before;
  const start = foldBefore ? k : 0;
  const end = Math.min(steps.length, c + 1 + following);
  const rest = steps.slice(end);
  const foldAfter = rest.length >= 2 && !open.after;
  return {
    ...(foldBefore ? {
      before: {
        from: steps[0]!.id, to: steps[k - 1]!.id, count: k,
        done: steps.slice(0, k).filter((s) => s.status === "done").length,
        skipped: steps.slice(0, k).filter((s) => s.status === "skipped").length,
      },
    } : {}),
    shown: steps.slice(start, foldAfter ? end : steps.length),
    ...(foldAfter ? { after: rest.map((s) => s.id) } : {}),
  };
}

/** The desktop's two columns, filled down the left first: the first half (rounded up) on the left. */
export function twoColumns<T>(items: readonly T[]): [T[], T[]] {
  const h = Math.ceil(items.length / 2);
  return [items.slice(0, h), items.slice(h)];
}
