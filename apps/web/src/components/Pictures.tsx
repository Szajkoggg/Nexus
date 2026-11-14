// Pictures in a chat's composer and in its sent messages (src/pictures.ts). A picture pasted, dropped on the chat or
// chosen with the attach button is checked here (its first bytes and its size), uploaded at once, and shown as a
// thumbnail above the box; sending puts each picture's path on its own line after the text. The attached paths are
// kept beside the draft, so they survive a reload like the text.
import { useEffect, useRef, useState } from "react";
import { HttpError, fileUrl, uploadPicture } from "../api.ts";
import { readDraft, writeDraft } from "../drafts.ts";
import { PICTURE_ACCEPT, parsePaths, pictureOk, picturesKey } from "../pictures.ts";
import { t } from "../i18n.ts";

interface Item { id: number; url: string; path?: string }

export interface Pictures {
  items: Item[];
  /** Uploads still running: the message waits for them. */
  busy: boolean;
  /** The uploaded pictures' paths, in order. */
  paths: string[];
  error?: string;
  add: (files: readonly File[]) => void;
  remove: (id: number) => void;
  /** After the message went: the composer starts empty. */
  clear: () => void;
}

let nextId = 0;

const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error ?? new Error("read failed"));
  r.readAsDataURL(file);
});

/** The pictures attached to a chat's draft. */
export function usePictures(project: string, draft: string): Pictures {
  const key = picturesKey(draft);
  const load = () => parsePaths(readDraft(key)).map((path) => ({ id: nextId++, url: fileUrl(project, path), path }));
  // Per draft: the same chat shown for another project (or conversation) starts from that draft's own pictures.
  const [state, setState] = useState<{ key: string; items: Item[] }>(() => ({ key, items: load() }));
  const [error, setError] = useState<string>();
  if (state.key !== key) { setState({ key, items: load() }); setError(undefined); }
  const items = state.key === key ? state.items : [];
  const live = useRef(items);
  live.current = items;
  // An upload that ends after the user moved to another draft is stored with the draft it was made for.
  const update = (f: (all: Item[]) => Item[], forKey = key) => setState((s) => {
    const base = s.key === forKey ? s.items : parsePaths(readDraft(forKey)).map((path) => ({ id: nextId++, url: "", path }));
    const next = f(base);
    writeDraft(forKey, next.flatMap((i) => (i.path ? [i.path] : [])).join("\n"));
    return s.key === forKey ? { key: forKey, items: next } : s;
  });
  // Object URLs of pictures not yet uploaded are released when the composer goes.
  useEffect(() => () => { for (const i of live.current) if (i.url.startsWith("blob:")) URL.revokeObjectURL(i.url); }, []);

  const addOne = async (file: File) => {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!pictureOk(file.size, head)) { setError(t("chat.pictureRefused")); return; }
    const id = nextId++;
    const url = URL.createObjectURL(file);
    const forKey = key;
    update((all) => [...all, { id, url }], forKey);
    try {
      const path = await uploadPicture(project, await readAsDataUrl(file));
      // Moved on meanwhile: the picture is added to the draft it was made for.
      update((all) => (all.some((i) => i.id === id) ? all.map((i) => (i.id === id ? { ...i, path } : i)) : [...all, { id, url, path }]), forKey);
    } catch (e) {
      update((all) => all.filter((i) => i.id !== id), forKey);
      URL.revokeObjectURL(url);
      const status = e instanceof HttpError ? e.status : 0;
      setError(status === 413 || status === 415 ? t("chat.pictureRefused") : t("chat.pictureFailed", { reason: (e as Error).message }));
    }
  };
  return {
    items,
    busy: items.some((i) => !i.path),
    paths: items.flatMap((i) => (i.path ? [i.path] : [])),
    error,
    add: (files) => { setError(undefined); for (const f of files) void addOne(f); },
    remove: (id) => { setError(undefined); update((all) => all.filter((i) => i.id !== id)); },
    clear: () => { setError(undefined); update(() => []); },
  };
}

/** The files a paste or a drop carries (a copied screenshot comes as a file too). */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files?.length) return [...data.files];
  return [...(data.items ?? [])].flatMap((i) => (i.kind === "file" ? [i.getAsFile()].filter((f): f is File => !!f) : []));
}

/** The thumbnails above the composer's box, each with ✕; an upload still running is dimmed. */
export function PictureStrip({ pictures }: { pictures: Pictures }) {
  if (!pictures.items.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {pictures.items.map((i) => (
        <div key={i.id} className="relative">
          <img src={i.url} alt={t("chat.picture")} className={`h-16 w-16 rounded-lg border border-line-strong object-cover ${i.path ? "" : "opacity-50"}`} />
          {!i.path && <span className="absolute inset-0 grid place-items-center text-xs text-fg" aria-label={t("chat.uploading")}><span className="animate-pulse">●</span></span>}
          <button onClick={() => pictures.remove(i.id)} aria-label={t("chat.removePicture")} title={t("chat.removePicture")}
            className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line-strong bg-surface-3 text-[11px] leading-none text-fg hover:bg-surface-4 max-lg:h-7 max-lg:w-7">✕</button>
        </div>
      ))}
    </div>
  );
}

/** The attach button: a paperclip that opens the file chooser (pictures only). */
export function AttachButton({ pictures, round }: { pictures: Pictures; round?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" accept={PICTURE_ACCEPT} multiple hidden
        onChange={(e) => { pictures.add([...(e.target.files ?? [])]); e.target.value = ""; }} />
      <button type="button" onClick={() => input.current?.click()} aria-label={t("chat.attach")} title={t("chat.attach")}
        className={`grid shrink-0 place-items-center text-fg-2 hover:text-fg ${round ? "h-11 w-11 rounded-full border border-line-strong bg-canvas" : "mb-1 h-9 w-9 rounded-lg hover:bg-surface-3"}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
        </svg>
      </button>
    </>
  );
}

/** The pictures of a sent message, below its text; a click opens the picture itself in a new tab. */
export function SentPictures({ project, paths }: { project: string; paths: readonly string[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-2">
      {paths.map((p) => (
        <a key={p} href={fileUrl(project, p)} target="_blank" rel="noreferrer" title={t("chat.openPicture")}>
          <img src={fileUrl(project, p)} alt={t("chat.picture")} loading="lazy" className="max-h-48 max-w-full rounded-lg border border-line-strong object-contain" />
        </a>
      ))}
    </div>
  );
}
