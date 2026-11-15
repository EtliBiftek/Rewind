import { getVoicePcm } from "./backend";
import { clock } from "./clock";
import type { Match } from "./model";
import { useStore } from "./store";

interface Active {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

/** WebAudio voice playback synchronised to the playback clock. */
class VoiceEngine {
  ctx: AudioContext | null = null;
  match: Match | null = null;
  buffers = new Map<number, AudioBuffer | null>(); // slot -> buffer (null = failed)
  loading = false;
  master: GainNode | null = null;
  gains = new Map<number, GainNode>();
  active: Active[] = [];
  scheduledKeys = new Set<string>();
  timer: number | null = null;
  scheduledCount = 0;
  epoch = 0;
  lookahead = 0.6;

  async attach(m: Match) {
    this.killActive();
    this.match = m;
    this.buffers.clear();
    this.scheduledCount = 0;
    this.loading = false;
    if (!m.demo.voice?.available) return;
    this.loading = true;
    try {
      const ctx = this.ensureCtx();
      const sr = m.demo.voice.sampleRate;
      await Promise.all(
        m.demo.voice.players.map(async (p) => {
          try {
            const raw = await getVoicePcm(p.steamId);
            const i16 = new Int16Array(raw, 0, raw.byteLength >> 1);
            const buf = ctx.createBuffer(1, Math.max(1, i16.length), sr);
            const ch = buf.getChannelData(0);
            for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
            this.buffers.set(p.slot, buf);
          } catch {
            this.buffers.set(p.slot, null);
          }
        }),
      );
    } finally {
      this.loading = false;
    }
    this.reschedule();
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as any).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  start() {
    if (this.timer == null) this.timer = window.setInterval(() => this.pump(), 120);
    window.addEventListener("pointerdown", () => this.ctx?.state === "suspended" && void this.ctx.resume(), { once: true });
  }
  stop() {
    this.killActive();
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  private killActive() {
    for (const a of this.active) {
      try {
        a.src.onended = null;
        a.src.stop();
      } catch {
        /* already stopped */
      }
      a.src.disconnect();
    }
    this.active = [];
    this.scheduledKeys.clear();
  }

  /** Called on seek / pause / play / speed / mute changes. */
  reschedule() {
    this.epoch++;
    this.killActive();
    this.pump();
  }

  private gainFor(slot: number): GainNode {
    let g = this.gains.get(slot);
    if (!g) {
      g = this.ctx!.createGain();
      g.connect(this.master!);
      this.gains.set(slot, g);
    }
    return g;
  }

  /** Effective gain of a player under the current voice settings. */
  effectiveGain(slot: number): number {
    const st = useStore.getState();
    const v = st.voice;
    const m = this.match;
    if (!m || !v.master) return 0;
    if (v.mutes[slot]) return 0;
    if (v.onlyTeam && m.players[slot]?.team !== m.players[st.selected]?.team) return 0;
    return (v.vols[slot] ?? 1) * v.masterVol;
  }

  private pump() {
    const m = this.match;
    if (!m || !this.ctx || !m.demo.voice?.available) return;
    const ctx = this.ctx;
    // update gains live
    for (const p of m.demo.voice.players) {
      const g = this.gainFor(p.slot);
      g.gain.value = this.effectiveGain(p.slot);
    }
    if (!clock.playing) return;
    const speed = clock.speed;
    if (speed < 0.5 || speed > 2) return; // muted outside a sane pitch range
    if (ctx.state === "suspended") void ctx.resume();
    const tickRate = m.tickRate;
    const sr = m.demo.voice.sampleRate;
    const nowTick = clock.tick;
    const horizonTick = nowTick + this.lookahead * speed * tickRate;
    const base = ctx.currentTime;
    for (const p of m.demo.voice.players) {
      const buf = this.buffers.get(p.slot);
      if (!buf) continue;
      if (this.effectiveGain(p.slot) <= 0) continue;
      for (let i = 0; i < p.segments.length; i++) {
        const s = p.segments[i];
        const durTicks = (s.sampleCount / sr) * tickRate;
        const endTick = s.startTick + durTicks;
        if (endTick <= nowTick || s.startTick > horizonTick) continue;
        const key = `${p.slot}:${i}:${this.epoch}`;
        if (this.scheduledKeys.has(key)) continue;
        this.scheduledKeys.add(key);
        // offset into the segment if we are already inside it
        const skipTicks = Math.max(0, nowTick - s.startTick);
        const offsetSamples = (skipTicks / tickRate) * sr;
        const remainingSamples = s.sampleCount - offsetSamples;
        if (remainingSamples <= 0) continue;
        const when = base + Math.max(0, (s.startTick - nowTick) / (tickRate * speed));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = speed;
        src.connect(this.gainFor(p.slot));
        const off = (s.sampleOffset + offsetSamples) / sr;
        const dur = remainingSamples / sr;
        src.start(when, off, dur);
        this.scheduledCount++;
        const a: Active = { src, gain: this.gainFor(p.slot) };
        this.active.push(a);
        src.onended = () => {
          this.active = this.active.filter((x) => x !== a);
        };
      }
    }
  }
}

export const voice = new VoiceEngine();
(window as any).__voice = voice;

let wired = false;
export function wireVoice() {
  if (wired) return;
  wired = true;
  clock.on((e) => {
    if (e === "play" || e === "pause" || e === "seek" || e === "speed") voice.reschedule();
    if (e === "match") {
      voice.stop();
      if (clock.match) {
        voice.start();
        void voice.attach(clock.match);
      }
    }
  });
  let prev = JSON.stringify([useStore.getState().voice, useStore.getState().selected]);
  useStore.subscribe((s) => {
    const cur = JSON.stringify([s.voice, s.selected]);
    if (cur !== prev) {
      prev = cur;
      voice.reschedule();
    }
  });
}
