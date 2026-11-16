import { useEffect, useState } from "react";
import type { Match } from "./model";

export type ClockEvent = "play" | "pause" | "seek" | "speed" | "tick" | "match";

/** Single playback clock (float ticks). Renderers read `clock.tick` each animation frame. */
class Clock {
  tick = 0;
  playing = false;
  speed = 1;
  skipFreeze = true;
  match: Match | null = null;
  private last = 0;
  private raf = 0;
  private listeners = new Set<(e: ClockEvent) => void>();

  on(fn: (e: ClockEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: ClockEvent) {
    for (const l of this.listeners) l(e);
  }

  setMatch(m: Match | null) {
    this.match = m;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.tick = m ? m.firstTick : 0;
    this.emit("match");
    this.emit("seek");
  }

  get tickRate() {
    return this.match?.tickRate ?? 64;
  }

  play() {
    const m = this.match;
    if (!m || this.playing) return;
    if (this.tick >= m.lastTick - 1) this.tick = m.firstTick;
    this.playing = true;
    this.last = performance.now();
    this.emit("play");
    const loop = (now: number) => {
      if (!this.playing) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.advance(dt * this.tickRate * this.speed);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit("pause");
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  private advance(dTicks: number) {
    const m = this.match;
    if (!m) return;
    let t = this.tick + dTicks;
    if (this.skipFreeze) {
      const r = m.roundAt(t);
      if (r && t >= r.startTick && t < r.freezeEndTick) t = r.freezeEndTick;
    }
    if (t >= m.lastTick) {
      this.tick = m.lastTick;
      this.pause();
      return;
    }
    this.tick = t;
    this.emit("tick");
  }
  seek(t: number) {
    const m = this.match;
    if (!m) return;
    this.tick = Math.min(m.lastTick, Math.max(m.firstTick, t));
    this.emit("seek");
  }
  seekBy(seconds: number) {
    this.seek(this.tick + seconds * this.tickRate);
  }
  setSpeed(s: number) {
    this.speed = s;
    this.emit("speed");
  }
  setSkipFreeze(v: boolean) {
    this.skipFreeze = v;
    this.emit("speed");
  }
}

export const clock = new Clock();

/** Re-render at a limited rate with the current tick. */
export function useTick(hz = 10): number {
  const [t, set] = useState(clock.tick);
  useEffect(() => {
    set(clock.tick);
    const id = setInterval(() => set(clock.tick), 1000 / hz);
    const off = clock.on((e) => {
      if (e === "seek" || e === "match") set(clock.tick);
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, [hz]);
  return t;
}
