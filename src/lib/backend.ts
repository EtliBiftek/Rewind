import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { DemoData, LibraryStats } from "./contract";

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

/** Browser/dev mode: use the exported fixtures. */
export async function loadFixtureDemo(onProgress: (p: Progress) => void): Promise<DemoData> {
  onProgress({ stage: "Örnek veri yükleniyor", pct: 0.1 });
  const demo = (await (await fetchOk("/fixtures/demo.json")).json()) as DemoData;
  onProgress({ stage: "Örnek veri yüklendi", pct: 1 });
  return demo;
}

export async function getFrames(): Promise<ArrayBuffer> {
  if (isTauri()) return toArrayBuffer(await invoke("get_frames"));
  return (await fetchOk("/fixtures/frames.bin")).arrayBuffer();
}

export async function getVoicePcm(steamId: string): Promise<ArrayBuffer> {
  if (isTauri()) return toArrayBuffer(await invoke("get_voice_pcm", { steamId }));
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
