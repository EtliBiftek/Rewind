import {
  FrameFlag,
  type BombEvent,
  type DemoData,
  type Grenade,
  type Insight,
  type KillEvent,
  type RoundInfo,
  type Side,
  type Vec3,
} from "./contract";
import { buildFloor, type Floor } from "./floor";

export interface PState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  flags: number;
  flash: number;
  weapon: number;
  money: number;
  equip: number;
}
export const newPState = (): PState => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, health: 0, armor: 0, flags: 0, flash: 0, weapon: -1, money: 0, equip: 0 });

export const has = (flags: number, f: number) => (flags & f) !== 0;
export const isAlive = (s: PState) => has(s.flags, FrameFlag.Alive) && s.health > 0;

export type BombKind = "carried" | "dropped" | "planted" | "defused" | "exploded" | "none";
export interface BombState {
  kind: BombKind;
  pos: Vec3 | null;
  plantedTick: number;
  site: "A" | "B" | null;
  carrier: number | null;
  defusing: number | null;
}

export class Match {
  demo: DemoData;
  frames: Float32Array;
  pc: number;
  stride: number;
  fc: number;
  start: number;
  interval: number;
  tickRate: number;
  firstTick: number;
  lastTick: number;
  killsByRound: KillEvent[][] = [];
  grenadesByRound: Grenade[][] = [];
  bombByRound: BombEvent[][] = [];
  grenadeById = new Map<number, Grenade>();
  insightById = new Map<number, Insight>();
  voicePcm = new Map<number, Float32Array>();
  private _floor: Floor | null = null;
  private _places: { name: string; x: number; y: number; n: number }[] | null = null;

  constructor(demo: DemoData, buf: ArrayBuffer) {
    this.demo = demo;
    const fm = demo.frames;
    this.frames = new Float32Array(buf);
    this.pc = fm.playerCount;
    this.stride = fm.stride || 12;
    this.fc = Math.min(fm.frameCount, Math.floor(this.frames.length / (this.pc * this.stride)));
    this.start = fm.startTick;
    this.interval = fm.sampleInterval || 4;
    this.tickRate = demo.header.tickRate || 64;
    this.firstTick = this.start;
    this.lastTick = this.start + Math.max(0, this.fc - 1) * this.interval;
    const n = demo.rounds.length;
    for (let i = 0; i < n; i++) {
      this.killsByRound.push([]);
      this.grenadesByRound.push([]);
      this.bombByRound.push([]);
    }
    const idx = (round: number) => Math.min(n - 1, Math.max(0, round - 1));
    for (const k of demo.kills ?? []) if (n) this.killsByRound[idx(k.round)].push(k);
    for (const g of demo.grenades ?? []) {
      if (n) this.grenadesByRound[idx(g.round)].push(g);
      this.grenadeById.set(g.id, g);
    }
    for (const b of demo.bombEvents ?? []) if (n) this.bombByRound[idx(b.round)].push(b);
    for (const i of demo.analysis?.insights ?? []) this.insightById.set(i.id, i);
    for (const a of this.killsByRound) a.sort((p, q) => p.tick - q.tick);
    for (const a of this.bombByRound) a.sort((p, q) => p.tick - q.tick);
  }

  get players() {
    return this.demo.players;
  }
  get rounds() {
    return this.demo.rounds;
  }
  get floor(): Floor {
    return (this._floor ??= buildFloor(this));
  }
  weaponName(idx: number): string {
    if (idx < 0) return "";
    return this.demo.frames.weapons?.[idx] ?? "";
  }

  raw(f: number, slot: number, k: number): number {
    return this.frames[(f * this.pc + slot) * this.stride + k];
  }

  frameIndex(tick: number): number {
    return Math.min(this.fc - 1, Math.max(0, Math.round((tick - this.start) / this.interval)));
  }

  /** Interpolated state of a player at a (float) tick. */
  sample(tick: number, slot: number, out: PState): PState {
    if (this.fc === 0 || slot < 0 || slot >= this.pc) return out;
    const ff = Math.min(this.fc - 1, Math.max(0, (tick - this.start) / this.interval));
    const f0 = Math.floor(ff);
    const f1 = Math.min(this.fc - 1, f0 + 1);
    const a = ff - f0;
    const d = this.frames;
    const s = this.stride;
    const o0 = (f0 * this.pc + slot) * s;
    const o1 = (f1 * this.pc + slot) * s;
    const dx = d[o1] - d[o0];
    const dy = d[o1 + 1] - d[o0 + 1];
    const teleport = dx * dx + dy * dy > 600 * 600 || (d[o0 + 7] & 2) !== (d[o1 + 7] & 2) && a < 1;
    const t = teleport ? 0 : a;
    out.x = d[o0] + dx * t;
    out.y = d[o0 + 1] + dy * t;
    out.z = d[o0 + 2] + (d[o1 + 2] - d[o0 + 2]) * t;
    let dyaw = d[o1 + 3] - d[o0 + 3];
    dyaw = ((((dyaw + 180) % 360) + 360) % 360) - 180;
    out.yaw = d[o0 + 3] + dyaw * t;
    out.pitch = d[o0 + 4] + (d[o1 + 4] - d[o0 + 4]) * t;
    out.health = d[o0 + 5];
    out.armor = d[o0 + 6];
    out.flags = d[o0 + 7];
    out.flash = d[o0 + 8];
    out.weapon = d[o0 + 9];
    out.money = d[o0 + 10];
    out.equip = d[o0 + 11];
    if (!teleport && (d[o1 + 7] & 2) === (d[o0 + 7] & 2)) out.health = d[o0 + 5] + (d[o1 + 5] - d[o0 + 5]) * t;
    return out;
  }

  roundIndexAt(tick: number): number {
    const r = this.rounds;
    if (!r.length) return -1;
    let lo = 0;
    let hi = r.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (r[mid].startTick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  roundAt(tick: number): RoundInfo | null {
    const i = this.roundIndexAt(tick);
    return i < 0 ? null : this.rounds[i];
  }

  sideOf(slot: number, tick: number, ps?: PState): Side {
    const p = ps ?? this.sample(tick, slot, newPState());
    if (has(p.flags, FrameFlag.Connected | FrameFlag.Alive) || p.flags !== 0) return has(p.flags, FrameFlag.SideCT) ? "CT" : "T";
    const r = this.roundAt(tick);
    return r ? r.teamSides[this.players[slot].team] : "CT";
  }
  sideInRound(slot: number, round: number): Side {
    const r = this.rounds[round - 1];
    return r ? r.teamSides[this.players[slot]?.team ?? 0] : "CT";
  }

  /** Seconds since freeze end (negative during freeze). */
  roundClock(tick: number): number {
    const r = this.roundAt(tick);
    return r ? (tick - r.freezeEndTick) / this.tickRate : 0;
  }

  bombState(tick: number): BombState {
    const ri = this.roundIndexAt(tick);
    const st: BombState = { kind: "carried", pos: null, plantedTick: 0, site: null, carrier: null, defusing: null };
    if (ri < 0) return { ...st, kind: "none" };
    const ps = newPState();
    for (const e of this.bombByRound[ri]) {
      if (e.tick > tick) break;
      switch (e.type) {
        case "pickup":
          st.kind = "carried";
          st.carrier = e.player;
          break;
        case "drop": {
          st.kind = "dropped";
          st.carrier = null;
          if (e.pos) st.pos = e.pos;
          else if (e.player != null) {
            this.sample(e.tick, e.player, ps);
            st.pos = [ps.x, ps.y, ps.z];
          }
          break;
        }
        case "planted":
          st.kind = "planted";
          st.pos = e.pos ?? st.pos;
          st.plantedTick = e.tick;
          st.site = e.site;
          break;
        case "defuse_begin":
          st.defusing = e.player;
          break;
        case "defuse_abort":
          st.defusing = null;
          break;
        case "defused":
          st.kind = "defused";
          st.defusing = null;
          break;
        case "exploded":
          st.kind = "exploded";
          break;
      }
    }
    return st;
  }

  /** Callout label positions derived from grenade landing/throw places. */
  get places() {
    if (this._places) return this._places;
    const m = new Map<string, { name: string; x: number; y: number; n: number }>();
    const add = (name: string | null, p: Vec3 | null) => {
      if (!name || !p) return;
      const e = m.get(name) ?? { name, x: 0, y: 0, n: 0 };
      e.x += p[0];
      e.y += p[1];
      e.n++;
      m.set(name, e);
    };
    for (const g of this.demo.grenades ?? []) {
      add(g.landPlace, g.detonatePos);
      add(g.throwPlace, g.throwPos);
    }
    for (const i of this.demo.analysis?.insights ?? []) add(i.suggestion?.landPlace ?? null, i.suggestion?.land ?? null);
    this._places = [...m.values()].map((e) => ({ name: e.name, x: e.x / e.n, y: e.y / e.n, n: e.n })).filter((e) => e.n >= 1);
    return this._places;
  }

  /** Is a player's voice active at this tick (derived from segment data)? */
  speakingSlots(tick: number): Set<number> {
    const out = new Set<number>();
    const v = this.demo.voice;
    if (!v?.available) return out;
    for (const p of v.players) {
      const segs = p.segments;
      let lo = 0;
      let hi = segs.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (segs[mid].startTick <= tick) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (best >= 0) {
        const s = segs[best];
        if (tick < s.startTick + (s.sampleCount / v.sampleRate) * this.tickRate) out.add(p.slot);
      }
    }
    return out;
  }

  playerKills(slot: number): KillEvent[] {
    return (this.demo.kills ?? []).filter((k) => k.attacker === slot);
  }
  playerDeaths(slot: number): KillEvent[] {
    return (this.demo.kills ?? []).filter((k) => k.victim === slot);
  }
}

export function grenadePos(g: Grenade, tick: number): Vec3 | null {
  const t = g.trajectory;
  if (!t || t.length < 4) return null;
  if (tick < t[0]) return null;
  const n = t.length / 4;
  const last = t[(n - 1) * 4];
  if (tick > last) return null;
  let i = 0;
  while (i < n - 1 && t[(i + 1) * 4] <= tick) i++;
  if (i >= n - 1) return [t[(n - 1) * 4 + 1], t[(n - 1) * 4 + 2], t[(n - 1) * 4 + 3]];
  const t0 = t[i * 4];
  const t1 = t[(i + 1) * 4];
  const f = t1 > t0 ? (tick - t0) / (t1 - t0) : 0;
  return [
    t[i * 4 + 1] + (t[(i + 1) * 4 + 1] - t[i * 4 + 1]) * f,
    t[i * 4 + 2] + (t[(i + 1) * 4 + 2] - t[i * 4 + 2]) * f,
    t[i * 4 + 3] + (t[(i + 1) * 4 + 3] - t[i * 4 + 3]) * f,
  ];
}

export function grenadeEnd(g: Grenade, tickRate: number): number {
  if (g.expireTick != null) return g.expireTick;
  if (g.detonateTick != null) {
    if (g.type === "smoke") return g.detonateTick + 18 * tickRate;
    if (g.type === "molotov") return g.detonateTick + 7 * tickRate;
    return g.detonateTick + 0.6 * tickRate;
  }
  const t = g.trajectory;
  return t.length >= 4 ? t[t.length - 4] : g.throwTick;
}

export const GRENADE_COLORS: Record<string, string> = {
  smoke: "#cbd5e1",
  flash: "#fff27a",
  he: "#ff6b4a",
  molotov: "#ff9b2f",
  decoy: "#a78bfa",
};
export const GRENADE_NAMES: Record<string, string> = { smoke: "Smoke", flash: "Flaş", he: "HE", molotov: "Molotof", decoy: "Decoy" };

export const SIDE_COLOR: Record<Side, string> = { CT: "#5aa9ff", T: "#f0a64a" };

export const WEAPON_LABELS: Record<string, string> = {
  ak47: "AK-47",
  m4a1: "M4A1",
  m4a1_silencer: "M4A1-S",
  awp: "AWP",
  usp_silencer: "USP-S",
  glock: "Glock-18",
  deagle: "Deagle",
  galilar: "Galil AR",
  famas: "FAMAS",
  hegrenade: "HE",
  flashbang: "Flaş",
  smokegrenade: "Smoke",
  molotov: "Molotof",
  incgrenade: "Yakıcı",
  inferno: "Ateş",
  knife: "Bıçak",
  mac10: "MAC-10",
  mp9: "MP9",
  p250: "P250",
  tec9: "Tec-9",
  fiveseven: "Five-SeveN",
  ssg08: "SSG 08",
  sg556: "SG 553",
  aug: "AUG",
  mp7: "MP7",
  mp5sd: "MP5-SD",
  ump45: "UMP-45",
  bizon: "PP-Bizon",
  nova: "Nova",
  xm1014: "XM1014",
  mag7: "MAG-7",
  sawedoff: "Sawed-Off",
  negev: "Negev",
  m249: "M249",
  g3sg1: "G3SG1",
  scar20: "SCAR-20",
  c4: "C4",
  taser: "Zeus",
  decoy: "Decoy",
  world: "Dünya",
};
export const weaponLabel = (w: string) => WEAPON_LABELS[w] ?? (w ? w.replace(/^weapon_/, "").replace(/_/g, " ") : "—");

export const CATEGORY_LABELS: Record<string, string> = {
  aim: "Nişan",
  entry: "Giriş",
  trade: "Takas",
  utility: "Yardımcı",
  clutch: "Clutch",
  survival: "Hayatta kalma",
  economy: "Ekonomi",
  positioning: "Pozisyon",
  objective: "Hedef",
};
export const catLabel = (c: string) => CATEGORY_LABELS[c] ?? c;

export const STYLE_LABELS: Record<string, string> = { stand: "Ayakta", jump: "Zıplayarak", run: "Koşarak", crouch: "Çömelerek", walk: "Yürüyerek" };
export const styleLabel = (s: string) => STYLE_LABELS[s] ?? s;

export const END_REASON: Record<string, string> = {
  bomb_exploded: "Bomba patladı",
  bomb_defused: "Bomba etkisiz",
  t_eliminated: "T elendi",
  ct_eliminated: "CT elendi",
  time_expired: "Süre doldu",
  unknown: "Bilinmiyor",
};
export const BUY_LABELS: Record<string, string> = { pistol: "Tabanca", eco: "Eko", force: "Force", full: "Tam alım" };

export function fmtClock(sec: number): string {
  const neg = sec < 0;
  const s = Math.abs(Math.round(sec));
  return `${neg ? "-" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
