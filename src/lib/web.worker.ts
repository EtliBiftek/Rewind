/// <reference lib="webworker" />
/**
 * The web version's backend: the Rust core compiled to WebAssembly (crates/rewind-web, built by
 * `npm run build:web` into public/wasm). Runs in a worker because the CS2 files are read with
 * FileReaderSync and the work is long and synchronous. Nothing leaves the user's computer.
 */

type Msg = { id: number; op: string; args: any };

let mod: any = null;
let demo: any = null;
let game: any = null;

async function wasm(): Promise<any> {
  if (!mod) {
    const base = new URL(self.name || import.meta.env.BASE_URL, self.location.href);
    // served as a static file (not bundled): the page builds without it in the desktop / fixture modes
    const m = await import(/* @vite-ignore */ new URL("wasm/rewind_web.js", base).href);
    await m.default({ module_or_path: new URL("wasm/rewind_web_bg.wasm", base) });
    mod = m;
  }
  return mod;
}

function out(id: number, u8: Uint8Array) {
  (self as unknown as Worker).postMessage({ id, ok: true, result: u8.buffer }, [u8.buffer]);
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const { id, op, args } = e.data;
  const progress = (stage: string, pct: number) => (self as unknown as Worker).postMessage({ id, progress: { stage, pct } });
  try {
    const m = await wasm();
    switch (op) {
      case "loadDemo": {
        demo?.free();
        demo = null;
        const bytes = new Uint8Array(await (args.file as File).arrayBuffer());
        demo = m.load_demo(bytes, args.file.name, progress);
        const frames: Uint8Array = demo.frames();
        (self as unknown as Worker).postMessage({ id, ok: true, result: { json: demo.data_json(), frames: frames.buffer } }, [frames.buffer]);
        return;
      }
      case "voice":
        return out(id, demo ? demo.voice_pcm(args.steamId) : new Uint8Array(0));
      case "setGame": {
        game?.free();
        game = null;
        game = new m.WebGame(args.paths, args.files);
        (self as unknown as Worker).postMessage({ id, ok: true, result: { maps: game.maps(), rev: game.export_rev() } });
        return;
      }
      case "exportMap":
        if (!game) throw new Error("CS2 klasörü seçilmedi");
        return out(id, game.export_map(args.map, args.quality, args.textures, progress));
      case "actor":
        if (!game) throw new Error("CS2 klasörü seçilmedi");
        return out(id, game.actor_asset(args.path, args.textures));
      default:
        throw new Error("bilinmeyen işlem: " + op);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((err as any)?.message ?? err) });
  }
};
