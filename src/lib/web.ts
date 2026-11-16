import type { Cs2Status, DemoData } from "./contract";

/**
 * The web version (GitHub Pages build, `vite build --mode web`): .dem files and the CS2 folder are picked by the user
 * and read locally by the WebAssembly worker (web.worker.ts). Nothing is uploaded.
 */
export const isWeb = (): boolean => import.meta.env.MODE === "web" && !("__TAURI_INTERNALS__" in window);

type Pending = { ok: (v: any) => void; fail: (e: Error) => void; progress?: (stage: string, pct: number) => void };
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function call<T>(op: string, args: any, progress?: (stage: string, pct: number) => void): Promise<T> {
  if (!worker) {
    // the page's base URL (the build uses relative paths): the worker resolves the WebAssembly files against it
    worker = new Worker(new URL("./web.worker.ts", import.meta.url), { type: "module", name: new URL(import.meta.env.BASE_URL, document.baseURI).href });
    worker.onmessage = (e) => {
      const d = e.data as { id: number; ok?: boolean; result?: any; error?: string; progress?: { stage: string; pct: number } };
      const p = pending.get(d.id);
      if (!p) return;
      if (d.progress) return p.progress?.(d.progress.stage, d.progress.pct);
      pending.delete(d.id);
      if (d.ok) p.ok(d.result);
      else p.fail(new Error(d.error ?? "Bilinmeyen hata"));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.fail(new Error("Web çalışanı hatası: " + (e.message || "yüklenemedi")));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = ++seq;
  return new Promise<T>((ok, fail) => {
    pending.set(id, { ok, fail, progress });
    worker!.postMessage({ id, op, args });
  });
}

// ---------------------------------------------------------------- demo

let frames: ArrayBuffer | null = null;

export async function webLoadDemo(file: File, onProgress: (p: { stage: string; pct: number }) => void): Promise<DemoData> {
  if (!/\.dem$/i.test(file.name)) throw new Error("Lütfen bir .dem dosyası seçin.");
  frames = null;
  const r = await call<{ json: string; frames: ArrayBuffer }>("loadDemo", { file }, (stage, pct) => onProgress({ stage, pct }));
  frames = r.frames;
  return JSON.parse(r.json) as DemoData;
}

export function webFrames(): ArrayBuffer {
  if (!frames) throw new Error("Yüklü demo yok");
  return frames;
}

export function webVoice(steamId: string): Promise<ArrayBuffer> {
  return call<ArrayBuffer>("voice", { steamId });
}

// ---------------------------------------------------------------- CS2 folder

/**
 * A classic folder input (`webkitdirectory`): it works in every browser and also for installs under Program Files,
 * which the File System Access picker refuses as a system folder. The browser lists the files; only the few the page
 * needs are read, in slices, locally.
 */
let status: Cs2Status | null = null;
/** Identity of the picked install's files (size + date), for the map cache key. */
let fileIds = new Map<string, string>();
let exportRev = 0;
const NOT_PICKED = "Gerçek harita ve oyuncu modelleri için CS2 klasörünü seçin (Counter-Strike Global Offensive). Dosyalar yüklenmez, yalnızca bu bilgisayarda okunur.";

function pickFiles(): Promise<File[] | null> {
  return new Promise((ok) => {
    const inp = document.createElement("input");
    inp.type = "file";
    (inp as any).webkitdirectory = true;
    inp.multiple = true;
    inp.style.display = "none";
    document.body.appendChild(inp);
    const done = (v: File[] | null) => (inp.remove(), ok(v));
    inp.addEventListener("change", () => done(inp.files?.length ? [...inp.files] : null));
    inp.addEventListener("cancel", () => done(null));
    inp.click();
  });
}

/** `game/csgo` files of a picked folder (the CS2 folder, `game`, `game/csgo` or a Steam library): path -> file. */
export function csgoFiles(files: File[]): { root: string; paths: string[]; files: File[] } | null {
  const rel = (f: File) => ((f as any).webkitRelativePath as string) || f.name;
  const dir = files.map(rel).find((p) => /(^|\/)pak01_dir\.vpk$/i.test(p) && !/\/maps\//i.test(p));
  if (!dir) return null;
  const root = dir.slice(0, dir.length - "pak01_dir.vpk".length);
  const paths: string[] = [];
  const out: File[] = [];
  for (const f of files) {
    const p = rel(f);
    if (!p.startsWith(root)) continue;
    const r = p.slice(root.length);
    if (/^pak01_(dir|\d{3})\.vpk$/i.test(r) || /^maps\/[^/]+\.vpk$/i.test(r)) (paths.push(r), out.push(f));
  }
  return { root, paths, files: out };
}

/** Status without prompting (the folder has to be picked again on each visit). */
export async function webCs2Status(): Promise<Cs2Status> {
  return status ?? { found: false, path: null, source: null, maps: [], error: NOT_PICKED };
}

/** Opens the folder picker (needs a click). Null when cancelled. */
export async function webPickCs2(): Promise<Cs2Status | null> {
  const files = await pickFiles();
  if (!files) return null;
  const g = csgoFiles(files);
  if (!g) throw new Error("Seçilen klasörde CS2 bulunamadı (game/csgo/pak01_dir.vpk yok). Counter-Strike Global Offensive klasörünü seçin.");
  const { maps, rev } = await call<{ maps: string[]; rev: number }>("setGame", { paths: g.paths, files: g.files });
  exportRev = rev;
  fileIds = new Map(g.paths.map((p, i) => [p, `${g.files[i].size}-${g.files[i].lastModified}`]));
  status = { found: true, path: `${g.root || "./"} (bu tarayıcı)`, source: "manual", maps, error: null };
  return status;
}

export async function webForgetCs2(): Promise<Cs2Status> {
  status = null;
  return { found: false, path: null, source: null, maps: [], error: NOT_PICKED };
}

// ---------------------------------------------------------------- assets

export async function webMapScene(map: string, quality: string, textures: string, onProgress?: (stage: string, pct: number) => void): Promise<ArrayBuffer> {
  if (!status?.found) throw new Error(NOT_PICKED);
  if (!status.maps.includes(map)) throw new Error(`Bu harita CS2 kurulumunda bulunamadı: ${map}`);
  // exports take a while in the browser (one thread): keep them in Cache Storage, keyed by the files they come from
  const key = `${location.pathname}__map/${map}.${quality}.${textures}.${exportRev}.${fileIds.get(`maps/${map}.vpk`)}.${fileIds.get("pak01_dir.vpk")}.glb`;
  const cache = await caches.open("rewind-maps").catch(() => null);
  const hit = await cache?.match(key);
  if (hit) {
    onProgress?.("Önbellekten yüklendi", 1);
    return hit.arrayBuffer();
  }
  const glb = await call<ArrayBuffer>("exportMap", { map, quality, textures }, onProgress);
  if (cache) {
    for (const k of await cache.keys()) if (k.url.includes(`__map/${map}.${quality}.${textures}.`)) await cache.delete(k);
    await cache.put(key, new Response(glb.slice(0), { headers: { "content-type": "model/gltf-binary" } })).catch(() => {});
  }
  return glb;
}

export async function webActorAsset(path: string, textures: string): Promise<ArrayBuffer> {
  if (!status?.found) throw new Error(NOT_PICKED);
  return call<ArrayBuffer>("actor", { path, textures });
}
