import * as THREE from "three";
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import { drawScene, fitView } from "../render/draw2d";
import { Scene3D, type CamMode } from "../render/scene3d";
import { drawOverlay3D } from "../render/hud";
import type { Match } from "./model";
import { voice } from "./voice";
import { useStore } from "./store";

export interface ExportOpts {
  match: Match;
  a: number;
  b: number;
  view: "2d" | "3d";
  cam: CamMode;
  selected: number;
  width: number;
  height: number;
  fps: number;
  format: "auto" | "mp4" | "webm";
  audio: boolean;
}
export interface ExportProgress {
  stage: string;
  frac: number;
  frame?: number;
  total?: number;
}
export interface ExportResult {
  data: ArrayBuffer;
  ext: "mp4" | "webm";
  method: "webcodecs" | "mediarecorder";
  warnings: string[];
  frames: number;
  hasAudio: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function webCodecsAvailable(): boolean {
  return typeof (window as any).VideoEncoder !== "undefined" && typeof (window as any).VideoFrame !== "undefined";
}

interface Renderer {
  canvas: HTMLCanvasElement;
  draw(tick: number): void;
  dispose(): void;
}

function makeRenderer(o: ExportOpts): Renderer {
  const { match: m, width: W, height: H } = o;
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  const st = useStore.getState();
  if (o.view === "2d") {
    const view = fitView(m, W, H);
    return {
      canvas: out,
      draw(tick) {
        drawScene(ctx, {
          match: m,
          tick,
          view,
          w: W,
          h: H,
          selected: o.selected,
          level: "all",
          radarImg: st.radarImg,
          showRadar: st.showRadarImg,
          labels: true,
          speaking: m.speakingSlots(tick),
          focus: null,
          coach: null,
          hud: true,
          feed: true,
          entities: true,
          now: 0,
          still: true,
        });
      },
      dispose() {},
    };
  }
  const gl = document.createElement("canvas");
  gl.width = W;
  gl.height = H;
  const r = new THREE.WebGLRenderer({ canvas: gl, antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(W, H, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  const sc = new Scene3D(m, r);
  const free = sc.defaultFree();
  const top = sc.defaultTop();
  return {
    canvas: out,
    draw(tick) {
      sc.update(tick, { mode: o.cam, selected: o.selected, free, top, w: W, h: H }, { speaking: m.speakingSlots(tick), focus: null, now: (tick / m.tickRate) * 1000 });
      ctx.drawImage(gl, 0, 0, W, H);
      drawOverlay3D(ctx, m, tick, o.selected, o.cam, W, H, false);
    },
    dispose() {
      sc.dispose();
      r.dispose();
    },
  };
}

interface CodecChoice {
  kind: "mp4" | "webm";
  codec: string;
}
async function pickCodec(o: ExportOpts): Promise<CodecChoice | null> {
  const VE = (window as any).VideoEncoder;
  const bitrate = Math.round((o.height >= 1000 ? 9_000_000 : 5_000_000) * (o.fps > 30 ? 1.5 : 1));
  const cands: CodecChoice[] = [];
  if (o.format !== "webm") for (const c of ["avc1.640034", "avc1.64002a", "avc1.4d0028", "avc1.42001f"]) cands.push({ kind: "mp4", codec: c });
  if (o.format !== "mp4") for (const c of ["vp09.00.40.08", "vp09.00.10.08", "vp8"]) cands.push({ kind: "webm", codec: c });
  if (o.format === "mp4") for (const c of ["vp09.00.40.08", "vp8"]) cands.push({ kind: "webm", codec: c }); // fall back, flagged by caller
  for (const c of cands) {
    try {
      const r = await VE.isConfigSupported({ codec: c.codec, width: o.width, height: o.height, bitrate, framerate: o.fps });
      if (r?.supported) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Mix unmuted voice tracks for [a,b] into a mono PCM buffer. */
async function mixVoice(o: ExportOpts): Promise<AudioBuffer | null> {
  const m = o.match;
  const info = m.demo.voice;
  if (!info?.available || !o.audio) return null;
  const sr = 48000;
  const dur = (o.b - o.a) / m.tickRate;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(dur * sr)), sr);
  let any = false;
  for (const p of info.players) {
    const gain = voice.effectiveGain(p.slot);
    if (!voice.buffers.get(p.slot) || gain <= 0) continue;
    const g = off.createGain();
    g.gain.value = gain;
    g.connect(off.destination);
    for (let i = 0; i < p.segments.length; i++) {
      const s = p.segments[i];
      const sd = s.sampleCount / info.sampleRate;
      const t0 = (s.startTick - o.a) / m.tickRate;
      if (t0 + sd <= 0 || t0 >= dur) continue;
      const buf = voice.segBuffer(p.slot, i);
      if (!buf) continue;
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      const skip = Math.max(0, -t0);
      src.start(Math.max(0, t0), skip, Math.min(sd - skip, dur - Math.max(0, t0)));
      any = true;
    }
  }
  if (!any) return null;
  return off.startRendering();
}

export async function runExport(o: ExportOpts, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
  if (webCodecsAvailable()) {
    try {
      return await runWebCodecs(o, onProgress, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      if ((e as any)?.code === "NO_CODEC") {
        /* fall through to MediaRecorder */
      } else throw e;
    }
  }
  return runMediaRecorder(o, onProgress, signal);
}

async function runWebCodecs(o: ExportOpts, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
  const warnings: string[] = [];
  onProgress({ stage: "Kodlayıcı hazırlanıyor", frac: 0 });
  let choice = await pickCodec(o);
  if (!choice) {
    const err: any = new Error("Uygun video kodlayıcı bulunamadı");
    err.code = "NO_CODEC";
    throw err;
  }
  if (o.format === "mp4" && choice.kind === "webm") warnings.push("MP4 (H.264) bu sistemde desteklenmiyor; WebM olarak kaydedildi.");
  const AE = (window as any).AudioEncoder;
  const ac = !!(AE && (window as any).AudioData);
  let audioBuf: AudioBuffer | null = null;
  let audioCodec: string | null = null;
  if (o.audio && ac && o.match.demo.voice?.available) {
    audioBuf = await mixVoice(o);
    if (audioBuf) {
      const ok = async (codec: string) => {
        try {
          return !!(await AE.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 }))?.supported;
        } catch {
          return false;
        }
      };
      const aacOk = await ok("mp4a.40.2");
      const opusOk = await ok("opus");
      if (choice.kind === "mp4" && !aacOk && opusOk && o.format === "auto") {
        const wc = await pickCodec({ ...o, format: "webm" });
        if (wc) {
          choice = wc;
          warnings.push("AAC kodlayıcı yok; ses içerebilmesi için WebM (Opus) seçildi.");
        }
      }
      const want = choice.kind === "mp4" ? "mp4a.40.2" : "opus";
      if ((want === "opus" && opusOk) || (want === "mp4a.40.2" && aacOk)) audioCodec = want;
      else warnings.push("Ses kodlayıcı desteklenmiyor; video sessiz kaydedildi.");
    }
  } else if (o.audio && o.match.demo.voice?.available && !ac) warnings.push("AudioEncoder yok; video sessiz kaydedildi.");
  const W = o.width,
    H = o.height;
  const target = choice.kind === "mp4" ? new Mp4Target() : new WebmTarget();
  const muxer: any =
    choice.kind === "mp4"
      ? new Mp4Muxer({ target: target as Mp4Target, video: { codec: "avc", width: W, height: H, frameRate: o.fps }, ...(audioCodec ? { audio: { codec: "aac", numberOfChannels: 1, sampleRate: 48000 } } : {}), fastStart: "in-memory" })
      : new WebmMuxer({ target: target as WebmTarget, video: { codec: choice.codec.startsWith("vp8") ? "V_VP8" : "V_VP9", width: W, height: H, frameRate: o.fps }, ...(audioCodec ? { audio: { codec: "A_OPUS", numberOfChannels: 1, sampleRate: 48000 } } : {}) });
  let encErr: unknown = null;
  const VE = (window as any).VideoEncoder;
  const enc = new VE({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (e: unknown) => (encErr = e),
  });
  enc.configure({ codec: choice.codec, width: W, height: H, bitrate: Math.round((H >= 1000 ? 9_000_000 : 5_000_000) * (o.fps > 30 ? 1.5 : 1)), framerate: o.fps, ...(choice.kind === "mp4" ? { avc: { format: "avc" } } : {}) });
  const renderer = makeRenderer(o);
  const total = Math.max(1, Math.round(((o.b - o.a) / o.match.tickRate) * o.fps));
  const stats = { render: 0, wait: 0, frames: total };
  (window as any).__exportStats = stats;
  try {
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException("İptal edildi", "AbortError");
      if (encErr) throw encErr;
      const tick = o.a + (i * o.match.tickRate) / o.fps;
      const tr0 = performance.now();
      renderer.draw(tick);
      stats.render += performance.now() - tr0;
      const VF = (window as any).VideoFrame;
      const frame = new VF(renderer.canvas, { timestamp: Math.round((i * 1e6) / o.fps), duration: Math.round(1e6 / o.fps) });
      enc.encode(frame, { keyFrame: i % (o.fps * 2) === 0 });
      frame.close();
      const tw0 = performance.now();
      while (enc.encodeQueueSize > 8) await sleep(4);
      stats.wait += performance.now() - tw0;
      if (i % 2 === 0) {
        onProgress({ stage: "Kareler oluşturuluyor", frac: (i / total) * 0.92, frame: i, total });
        await sleep(0);
      }
    }
    onProgress({ stage: "Video tamamlanıyor", frac: 0.93, frame: total, total });
    await enc.flush();
    enc.close();
    if (audioBuf && audioCodec) {
      onProgress({ stage: "Ses kodlanıyor", frac: 0.95 });
      const AD = (window as any).AudioData;
      const aenc = new AE({ output: (chunk: any, meta: any) => muxer.addAudioChunk(chunk, meta), error: (e: unknown) => (encErr = e) });
      aenc.configure({ codec: audioCodec, sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 });
      const ch = audioBuf.getChannelData(0);
      const CH = 48000;
      for (let off = 0; off < ch.length; off += CH) {
        const n = Math.min(CH, ch.length - off);
        const data = new AD({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round((off / 48000) * 1e6), data: ch.slice(off, off + n) });
        aenc.encode(data);
        data.close();
      }
      await aenc.flush();
      aenc.close();
    }
    if (encErr) throw encErr;
    muxer.finalize();
  } finally {
    renderer.dispose();
    try {
      if (enc.state !== "closed") enc.close();
    } catch {
      /* ignore */
    }
  }
  onProgress({ stage: "Tamamlandı", frac: 1, frame: total, total });
  return { data: (muxer.target as { buffer: ArrayBuffer }).buffer, ext: choice.kind, method: "webcodecs", warnings, frames: total, hasAudio: !!audioCodec };
}

/** Real-time fallback (WebKitGTK etc.): canvas.captureStream + MediaRecorder. */
async function runMediaRecorder(o: ExportOpts, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
  const warnings = ["WebCodecs kullanılamıyor: gerçek zamanlı kayıt (MediaRecorder) ile dışa aktarılıyor; işlem video süresi kadar sürer."];
  const MR = (window as any).MediaRecorder;
  if (!MR) throw new Error("Bu sistemde ne WebCodecs ne de MediaRecorder var; video dışa aktarılamıyor.");
  const renderer = makeRenderer(o);
  const stream: MediaStream = (renderer.canvas as any).captureStream(o.fps);
  let actx: AudioContext | null = null;
  let hasAudio = false;
  if (o.audio && o.match.demo.voice?.available && voice.buffers.size) {
    actx = new AudioContext();
    const dest = actx.createMediaStreamDestination();
    const info = o.match.demo.voice;
    const base = actx.currentTime + 0.2;
    for (const p of info.players) {
      const gain = voice.effectiveGain(p.slot);
      if (!voice.buffers.get(p.slot) || gain <= 0) continue;
      const g = actx.createGain();
      g.gain.value = gain;
      g.connect(dest);
      for (let i = 0; i < p.segments.length; i++) {
        const s = p.segments[i];
        const sd = s.sampleCount / info.sampleRate;
        const t0 = (s.startTick - o.a) / o.match.tickRate;
        if (t0 + sd <= 0 || t0 >= (o.b - o.a) / o.match.tickRate) continue;
        const buf = voice.segBuffer(p.slot, i);
        if (!buf) continue;
        const src = actx.createBufferSource();
        src.buffer = buf;
        src.connect(g);
        const skip = Math.max(0, -t0);
        src.start(base + Math.max(0, t0), skip, sd - skip);
        hasAudio = true;
      }
    }
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  }
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((m) => MR.isTypeSupported?.(m)) ?? "";
  const rec = new MR(stream, { mimeType: mime || undefined, videoBitsPerSecond: o.height >= 1000 ? 8_000_000 : 4_500_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e: BlobEvent) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start(500);
  const durMs = ((o.b - o.a) / o.match.tickRate) * 1000;
  const t0 = performance.now();
  let frames = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("İptal edildi", "AbortError");
      const el = performance.now() - t0;
      if (el >= durMs) break;
      renderer.draw(o.a + (el / 1000) * o.match.tickRate);
      frames++;
      onProgress({ stage: "Gerçek zamanlı kayıt", frac: Math.min(0.99, el / durMs), frame: frames });
      await sleep(1000 / o.fps);
    }
  } finally {
    if (rec.state !== "inactive") rec.stop();
    await stopped;
    renderer.dispose();
    stream.getTracks().forEach((t) => t.stop());
    actx?.close();
  }
  const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
  const ext = (rec.mimeType || "").includes("mp4") ? "mp4" : "webm";
  return { data: await blob.arrayBuffer(), ext, method: "mediarecorder", warnings, frames, hasAudio };
}
