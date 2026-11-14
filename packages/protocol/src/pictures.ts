// Review pictures with a view key: what a picture is compared with, and why a pair is refused. Pure and free of Node:
// the CLI checks a picture with it before recording it, and the dashboard (`@nexus/protocol/pictures`) pairs with it.
// The standard these rules belong to is `nexus help review` (packages/cli/src/help.ts).

/**
 * What a keyed picture is in its comparison: `before` the old state, `mockup` the design, `after` the new state (pairs
 * with the before or mockup of its key, else with its own key's after or result of an earlier round), `variant-a`/
 * `variant-b` two alternatives (b pairs with a), `result` a new screen with nothing to compare (stands alone).
 */
export const PICTURE_ROLES = ["before", "mockup", "after", "variant-a", "variant-b", "result"] as const;
export type PictureRole = (typeof PICTURE_ROLES)[number];

/**
 * A view key: the view's subject and state in lowercase words joined by hyphens (dots allowed), then `@` and the
 * window's width in CSS pixels, e.g. `waiting-tab@492`, `step-sheet-open-question@390`.
 */
export const VIEW_KEY = /^[a-z0-9]+(?:[-.][a-z0-9]+)*@[1-9][0-9]*$/;

/** Where every refusal points. */
export const REVIEW_HELP = "See: nexus help review";

/** Pixel dimensions of a picture file. */
export interface PictureSize { width: number; height: number }

/** What the rules read of a review item. */
export interface KeyedLike { path?: string; key?: string; role?: PictureRole; round?: number; size?: PictureSize }

/** How a picture is compared with its counterpart: its before, its mockup, the other variant, or an earlier round's picture. */
export type Comparison = "before" | "mockup" | "variant" | "round";

export interface Counterpart<T> { item: T; compare: Comparison }

/** The subject-and-state part of a key (before the `@`), and its width. */
export function splitKey(key: string): { view: string; width: number } {
  const at = key.lastIndexOf("@");
  return { view: key.slice(0, at), width: Number(key.slice(at + 1)) };
}

/**
 * The counterpart of a keyed picture among the items added before it (in the order they were added): for an `after`
 * the latest `before` or `mockup` of its key, else the latest `after` or `result` of its key from the latest earlier
 * round (a new screen added as a result in round 1 and taken again in round 2 is compared with round 1); for a
 * `variant-b` the latest `variant-a` of its key. Other roles, and pictures without a key, have none.
 */
export function counterpartOf<T extends KeyedLike>(earlier: readonly T[], pic: KeyedLike): Counterpart<T> | undefined {
  if (!pic.key || !pic.role) return undefined;
  const same = earlier.filter((x) => x.path && x.key === pic.key);
  if (pic.role === "after") {
    const base = same.filter((x) => x.role === "before" || x.role === "mockup").at(-1);
    if (base) return { item: base, compare: base.role as "before" | "mockup" };
    const round = pic.round;
    if (round === undefined) return undefined;
    const prior = same.filter((x) => (x.role === "after" || x.role === "result") && x.round !== undefined && x.round < round);
    // Stable sort: within the latest earlier round, the one added last.
    const best = prior.sort((a, b) => a.round! - b.round!).at(-1);
    return best ? { item: best, compare: "round" } : undefined;
  }
  if (pic.role === "variant-b") {
    const a = same.filter((x) => x.role === "variant-a").at(-1);
    return a ? { item: a, compare: "variant" } : undefined;
  }
  return undefined;
}

/** A picture about to be added: its key, role, round, path (as it will be recorded) and pixel size. */
export interface NewPicture { path: string; key: string; role: PictureRole; round?: number; size: PictureSize }

export type PictureCheck<T> =
  | { ok: true; counterpart?: Counterpart<T> }
  | { ok: false; reason: "key-format" | "other-key" | "missing" | "size"; message: string };

const sizeText = (s: PictureSize) => `${s.width}×${s.height} px`;
const counterpartName: Record<Exclude<Comparison, "round">, string> = { before: "its before", mockup: "its mockup", variant: "variant-a" };

/**
 * Whether a keyed picture may be added to a step that already has `earlier` items (`where` names the step, e.g.
 * "RS/RS1"). Refused, with the reason and the pointer to `nexus help review`: a key not in the key format; an
 * `after` or `variant-b` without a counterpart of its key (`other-key` when the step has the same view at another
 * width, with a role it could pair with: the likely mix-up; else `missing`); a counterpart of other pixel dimensions.
 */
export function checkPicture<T extends KeyedLike>(earlier: readonly T[], pic: NewPicture, where: string): PictureCheck<T> {
  if (!VIEW_KEY.test(pic.key)) {
    return { ok: false, reason: "key-format", message:
      `refused: "${pic.key}" is not a view key. A key names the view's subject and state in lowercase words joined by `
      + `hyphens, then @ and the window's width in CSS pixels, e.g. waiting-tab@492. ${REVIEW_HELP}` };
  }
  const found = counterpartOf(earlier, pic);
  if (found) {
    const other = found.item.size;
    if (other && (other.width !== pic.size.width || other.height !== pic.size.height)) {
      const what = found.compare === "round" ? `the ${found.item.role} of round ${found.item.round}` : counterpartName[found.compare];
      return { ok: false, reason: "size", message:
        `refused: the ${pic.role} ${pic.key} is ${sizeText(pic.size)}, ${what} (${found.item.path}) is ${sizeText(other)}. `
        + `The two pictures of a pair have the same pixel size: fixed-viewport captures (the window, not the full page) `
        + `of the same window size and zoom. Take the one that differs again. ${REVIEW_HELP}` };
    }
    return { ok: true, counterpart: found };
  }
  if (pic.role !== "after" && pic.role !== "variant-b") return { ok: true };

  // No counterpart: say what the step has that this picture could have meant.
  const wanted: readonly (PictureRole | undefined)[] = pic.role === "after" ? ["before", "mockup"] : ["variant-a"];
  const keyed = earlier.filter((x) => x.path && x.key && wanted.includes(x.role));
  // The likely mix-up: the same view (subject and state) at another width, also an earlier round's after of it.
  const { view } = splitKey(pic.key);
  const near = earlier.filter((x) => x.path && x.key && x.key !== pic.key && splitKey(x.key).view === view
    && (wanted.includes(x.role) || (pic.role === "after" && (x.role === "after" || x.role === "result"))));
  const list = (xs: readonly T[]) => [...new Set(xs.map((x) => `${x.key} (${x.role}${(x.role === "after" || x.role === "result") && x.round !== undefined ? `, round ${x.round}` : ""})`))].join(", ");
  const needs = pic.role === "after"
    ? `An after pairs with the before or mockup of the same key, or with the after or result of the same key from an earlier round.`
    : `A variant-b pairs with the variant-a of the same key, added first.`;
  const fix = pic.role === "after"
    ? `Add its before or mockup first (--key ${pic.key} --role before|mockup), or, for a new screen with nothing to compare, add it as --role result.`
    : `Add variant-a first (--key ${pic.key} --role variant-a).`;
  if (near.length) {
    return { ok: false, reason: "other-key", message:
      `refused: the ${pic.role} ${pic.key} has nothing to pair with in ${where}: the step has ${list(near)}, another key. `
      + `Pictures pair only by the same key: the same view, in the same state, at the same width. ${needs} `
      + `Take its ${pic.role === "after" ? "before or mockup" : "variant-a"} of this view at this width and add it first `
      + `(--key ${pic.key} --role ${pic.role === "after" ? "before|mockup" : "variant-a"}). ${REVIEW_HELP}` };
  }
  return { ok: false, reason: "missing", message:
    `refused: the ${pic.role} ${pic.key} has nothing to pair with in ${where}${keyed.length ? ` (the step has ${list(keyed)})` : ""}. `
    + `${needs} ${fix} ${REVIEW_HELP}` };
}

/**
 * The pixel size of a PNG, JPEG, GIF or WebP file from its bytes; undefined for anything else (or a file too short).
 */
export function pictureSize(b: Uint8Array): PictureSize | undefined {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
  // PNG: the signature, then IHDR's width and height.
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return ok(u32be(16), u32be(20));
  // GIF: the logical screen size.
  if (b.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return ok(u16le(6), u16le(8));
  // WebP: the RIFF container, then a VP8 (lossy), VP8L (lossless) or VP8X (extended) chunk.
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X") return ok(u24le(24) + 1, u24le(27) + 1);
    return undefined;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return ok(u16be(i + 7), u16be(i + 5));
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}
