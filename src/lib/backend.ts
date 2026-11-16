import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Cs2Status, DemoData, LibraryStats, MapProgress, MapQuality } from "./contract";
import { isWeb, webActorAsset, webCs2Status, webForgetCs2, webFrames, webLoadDemo, webMapScene, webVoice } from "./web";

export { isWeb };

export interface Progress {
  stage: string;
  pct: number;
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} yüklenemedi (HTTP ${r.status})`);
  return r;
}

function toArrayBuffer(v: unknown): ArrayBuffer {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) {
    const u = v as Uint8Array;
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(v)) return new Uint8Array(v as number[]).buffer as ArrayBuffer;
  throw new Error("Beklenmeyen ikili veri biçimi");
}

/** Load a .dem through the Rust backend. */
export async function loadDemoFromPath(path: string, onProgress: (p: Progress) => void): Promise<DemoData> {
  const un = await listen<Progress>("demo-progress", (e) => onProgress(e.payload));
  try {
    return await invoke<DemoData>("load_demo", { path });
  } finally {
    un();
  }
}

/** Web version: parse a picked / dropped .dem in the WebAssembly worker. */
export function loadDemoFromFile(file: File, onProgress: (p: Progress) => void): Promise<DemoData> {
  return webLoadDemo(file, onProgress);
}

/** Browser/dev mode: use the exported fixtures. */
export async function loadFixtureDemo(onProgress: (p: Progress) => void): Promise<DemoData> {
  onProgress({ stage: "Örnek veri yükleniyor", pct: 0.1 });
  const demo = (await (await fetchOk("/fixtures/demo.json")).json()) as DemoData;
  onProgress({ stage: "Örnek veri yüklendi", pct: 1 });
  return demo;
}

export async function getFrames(): Promise<ArrayBuffer> {
  if (isTauri()) return toArrayBuffer(await invoke("get_frames"));
  if (isWeb()) return webFrames();
  return (await fetchOk("/fixtures/frames.bin")).arrayBuffer();
}

export async function getVoicePcm(steamId: string): Promise<ArrayBuffer> {
  if (isTauri()) return toArrayBuffer(await invoke("get_voice_pcm", { steamId }));
  if (isWeb()) return webVoice(steamId);
  return (await fetchOk(`/fixtures/voice_${steamId}.bin`)).arrayBuffer();
}

export async function libraryStats(): Promise<LibraryStats | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<LibraryStats>("library_stats");
  } catch {
    return null;
  }
}

/** Demo passed on the command line (file association), Tauri only. */
export async function initialDemo(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return (await invoke<string | null>("initial_demo")) ?? null;
  } catch {
    return null;
  }
}

export async function pickDemoFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const r = await openDialog({ multiple: false, directory: false, filters: [{ name: "CS2 Demo", extensions: ["dem"] }] });
  if (!r) return null;
  return Array.isArray(r) ? (r[0] ?? null) : r;
}

export interface Saver {
  /** Human readable destination (for the UI). */
  target: string;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

const hdr = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : encodeURIComponent(s));

/** Ask where to save; in the browser a download is triggered at close(). Returns null when cancelled. */
export async function createSaver(suggestedName: string, ext: string): Promise<Saver | null> {
  if (isTauri()) {
    const path = await saveDialog({ defaultPath: suggestedName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return null;
    let first = true;
    return {
      target: path,
      async write(chunk) {
        await invoke("write_file", chunk, { headers: { "x-path": hdr(path), "x-append": first ? "0" : "1" } });
        first = false;
      },
      async close() {
        if (first) await invoke("write_file", new Uint8Array(0), { headers: { "x-path": hdr(path), "x-append": "0" } });
      },
    };
  }
  const parts: Uint8Array[] = [];
  const mime = ext === "mp4" ? "video/mp4" : ext === "webm" ? "video/webm" : "application/octet-stream";
  return {
    target: suggestedName,
    async write(chunk) {
      parts.push(chunk.slice());
    },
    async close() {
      const blob = new Blob(parts as BlobPart[], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      (window as any).__lastDownload = { name: suggestedName, size: blob.size };
    },
  };
}

/** Write a whole buffer in chunks. */
export async function saveBuffer(saver: Saver, buf: ArrayBuffer, onProgress?: (f: number) => void): Promise<void> {
  const CH = 8 * 1024 * 1024;
  const u = new Uint8Array(buf);
  for (let o = 0; o < u.length; o += CH) {
    await saver.write(u.subarray(o, Math.min(u.length, o + CH)));
    onProgress?.(Math.min(1, (o + CH) / u.length));
  }
  await saver.close();
}

/** Tauri drag & drop of files from the OS (paths). Returns an unsubscribe fn. */
export async function onFileDrop(cb: (paths: string[]) => void, onHover?: (over: boolean) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const un = await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload as { type: string; paths?: string[] };
    if (p.type === "enter" || p.type === "over") onHover?.(true);
    else if (p.type === "leave") onHover?.(false);
    else if (p.type === "drop") {
      onHover?.(false);
      if (p.paths?.length) cb(p.paths);
    }
  });
  return un;
}

/* ------------------------------------------------------------------ real map (CS2 install) */

/** Where the CS2 install is and which maps it has. Browser mode: only the fixture map (if exported) is "available". */
export async function cs2Status(mapHint?: string): Promise<Cs2Status> {
  if (isTauri()) return await invoke<Cs2Status>("cs2_status");
  if (isWeb()) return webCs2Status();
  const maps: string[] = [];
  if (mapHint) {
    try {
      const r = await fetch(`/fixtures/map_${mapHint}.glb`, { method: "HEAD" });
      if (r.ok) maps.push(mapHint);
    } catch {
      /* offline */
    }
  }
  return { found: maps.length > 0, path: maps.length ? "/fixtures" : null, source: maps.length ? "auto" : null, maps, error: maps.length ? null : "Tarayıcı modu: örnek harita dosyası yok" };
}

export async function setCs2Path(path: string | null): Promise<Cs2Status> {
  if (isWeb()) return path === null ? webForgetCs2() : webCs2Status();
  return await invoke<Cs2Status>("set_cs2_path", { path });
}

export async function pickCs2Folder(): Promise<string | null> {
  if (!isTauri()) return null;
  const r = await openDialog({ multiple: false, directory: true, title: "Counter-Strike 2 klasörünü seçin (…/Counter-Strike Global Offensive)" });
  if (!r) return null;
  return Array.isArray(r) ? (r[0] ?? null) : r;
}

/** The real map as binary glTF. Throws a Turkish message when unavailable. */
export async function getMapScene(mapName: string, quality: MapQuality, textures: "ktx2" | "image", onProgress?: (p: MapProgress) => void): Promise<ArrayBuffer> {
  if (isTauri()) {
    const un = await listen<MapProgress>("map-progress", (e) => onProgress?.(e.payload));
    try {
      return toArrayBuffer(await invoke("get_map_scene", { mapName, quality, textures }));
    } finally {
      un();
    }
  }
  if (isWeb()) return webMapScene(mapName, quality, textures, (stage, pct) => onProgress?.({ map: mapName, stage, pct }));
  onProgress?.({ map: mapName, stage: "Örnek harita indiriliyor", pct: 0.2 });
  const r = await fetch(`/fixtures/map_${mapName}.glb`);
  if (!r.ok) throw new Error(`Bu harita için örnek dosya yok (map_${mapName}.glb)`);
  const b = await r.arrayBuffer();
  onProgress?.({ map: mapName, stage: "Örnek harita indirildi", pct: 0.6 });
  return b;
}

/**
 * A CS2 agent / weapon model (skinned GLB in Source space) or an animation resource (its KV3 data as JSON) from the user's
 * install. Browser mode: `/fixtures/actors/<path>` (made by `cargo run --example actor_fixtures`). Throws when unavailable.
 */
export async function getActorAsset(path: string, textures: "ktx2" | "image"): Promise<ArrayBuffer> {
  if (isTauri()) return toArrayBuffer(await invoke("get_actor_asset", { path, textures }));
  if (isWeb()) return webActorAsset(path, textures);
  const r = await fetch(`/fixtures/actors/${path}`);
  if (!r.ok) throw new Error(`Örnek dosya yok: ${path}`);
  return r.arrayBuffer();
}
