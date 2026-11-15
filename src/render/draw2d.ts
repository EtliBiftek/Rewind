import { FrameFlag, type Grenade, type Insight, type KillEvent, type Side, type UtilitySuggestion, type Vec3 } from "../lib/contract";
import { rasterizeLevel } from "../lib/floor";
import {
  GRENADE_COLORS,
  Match,
  SIDE_COLOR,
  grenadeEnd,
  grenadePos,
  has,
  isAlive,
  newPState,
  styleLabel,
  weaponLabel,
  fmtClock,
  type PState,
} from "../lib/model";

export interface View2D {
  cx: number; // world x at centre of the canvas
  cy: number; // world y at centre of the canvas
  s: number; // pixels per world unit
}

export interface CoachOverlay {
  grenade: Grenade | null;
  suggestion: UtilitySuggestion;
  insight: Insight;
}
export interface HeatLayer {
  points: { x: number; y: number; w?: number }[];
  color: [number, number, number];
  radius: number; // px
}

export interface Draw2DOpts {
  match: Match;
  tick: number;
  view: View2D;
  w: number;
  h: number;
  selected: number;
  level: "all" | "upper" | "lower";
  radarImg: HTMLImageElement | null;
  showRadar: boolean;
  labels: boolean;
  speaking: Set<number>;
  focus: { pos: Vec3; ts: number } | null;
  coach: CoachOverlay | null;
  heat?: HeatLayer[];
  hud?: boolean;
  feed?: boolean;
  entities?: boolean;
  now: number;
  /** only for tests/exports: hide pulsing animations */
  still?: boolean;
}

const BG = "#0c121b";
const rasterCache = new WeakMap<Match, HTMLCanvasElement[]>();

function rasters(m: Match): HTMLCanvasElement[] {
  let r = rasterCache.get(m);
  if (!r) {
    const f = m.floor;
    r = f.levels.map((_, i) => rasterizeLevel(f, i, i === 0 ? [44, 62, 84] : [58, 52, 86], i === 0 ? [112, 150, 190] : [150, 130, 205]));
    rasterCache.set(m, r);
  }
  return r;
}

/** Fit view for the whole map into w x h. */
export function fitView(m: Match, w: number, h: number): View2D {
  const f = m.floor;
  const x0 = f.ox,
    y0 = f.oy,
    x1 = f.ox + f.w * f.cell,
    y1 = f.oy + f.h * f.cell;
  const s = Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.94;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s };
}

const pstates: PState[] = Array.from({ length: 16 }, newPState);

export function drawScene(ctx: CanvasRenderingContext2D, o: Draw2DOpts) {
  const { match: m, tick, view, w, h } = o;
  const S = view.s;
  const X = (wx: number) => w / 2 + (wx - view.cx) * S;
  const Y = (wy: number) => h / 2 - (wy - view.cy) * S;
  ctx.save();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // ---- background grid
  ctx.strokeStyle = "rgba(120,150,190,0.05)";
  ctx.lineWidth = 1;
  const gstep = 256 * S >= 24 ? 256 : 1024;
  ctx.beginPath();
  const gx0 = Math.floor((view.cx - w / 2 / S) / gstep) * gstep;
  for (let gx = gx0; gx < view.cx + w / 2 / S; gx += gstep) {
    ctx.moveTo(Math.round(X(gx)) + 0.5, 0);
    ctx.lineTo(Math.round(X(gx)) + 0.5, h);
  }
  const gy0 = Math.floor((view.cy - h / 2 / S) / gstep) * gstep;
  for (let gy = gy0; gy < view.cy + h / 2 / S; gy += gstep) {
    ctx.moveTo(0, Math.round(Y(gy)) + 0.5);
    ctx.lineTo(w, Math.round(Y(gy)) + 0.5);
  }
  ctx.stroke();

  // ---- floor / radar
  const map = m.demo.map;
  const useRadar = o.showRadar && o.radarImg && map.known;
  if (useRadar) {
    const img = o.radarImg!;
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.95;
    const size = 1024 * map.scale * S;
    ctx.drawImage(img, X(map.posX), Y(map.posY), size, size);
    ctx.globalAlpha = 1;
  } else {
    const f = m.floor;
    const rs = rasters(m);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const order = f.levels.length === 2 ? [1, 0] : [0];
    for (const lv of order) {
      let a = 1;
      if (f.levels.length === 2) {
        const sel = o.level;
        if (sel === "all") a = lv === 1 ? 0.55 : 1;
        else if (sel === "upper") a = lv === 1 ? 0.12 : 1;
        else a = lv === 0 ? 0.12 : 1;
      }
      ctx.globalAlpha = a;
      ctx.drawImage(rs[lv], X(f.ox), Y(f.oy + f.h * f.cell), f.w * f.cell * S, f.h * f.cell * S);
    }
    ctx.globalAlpha = 1;
  }

  // ---- heat layers
  if (o.heat) {
    for (const layer of o.heat) {
      const off = heatCanvas(layer, view, w, h);
      ctx.drawImage(off, 0, 0, w, h);
    }
  }

  // ---- callouts
  if (o.labels) {
    ctx.font = "600 10px system-ui, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of m.places) {
      const x = X(p.x),
        y = Y(p.y);
      if (x < -50 || y < -20 || x > w + 50 || y > h + 20) continue;
      ctx.fillStyle = "rgba(10,14,22,0.55)";
      const tw = ctx.measureText(p.name).width + 8;
      ctx.fillRect(x - tw / 2, y - 7, tw, 14);
      ctx.fillStyle = "rgba(190,205,225,0.8)";
      ctx.fillText(p.name, x, y + 0.5);
    }
  }

  const ri = m.roundIndexAt(tick);
  const round = ri >= 0 ? m.rounds[ri] : null;
  const tr = m.tickRate;

  if (o.entities !== false && round) {
    // bomb sites
    const bs = m.bombByRound[ri];
    // ---- smoke / fire areas
    for (const g of m.grenadesByRound[ri]) {
      if (g.detonateTick == null || !g.detonatePos) continue;
      const dt = (tick - g.detonateTick) / tr;
      if (dt < 0) continue;
      const end = grenadeEnd(g, tr);
      const x = X(g.detonatePos[0]),
        y = Y(g.detonatePos[1]);
      if (g.type === "smoke" && tick < end) {
        const total = (end - g.detonateTick) / tr;
        const grow = Math.min(1, dt / 0.6);
        const fade = Math.min(1, (total - dt) / 1.5);
        const r = 144 * S * (0.6 + 0.4 * grow);
        const grd = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
        grd.addColorStop(0, `rgba(205,215,228,${0.62 * fade})`);
        grd.addColorStop(0.75, `rgba(180,192,208,${0.5 * fade})`);
        grd.addColorStop(1, `rgba(170,182,200,${0.1 * fade})`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(230,238,248,${0.55 * fade})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        // remaining time arc
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * fade})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, 1 - dt / total));
        ctx.stroke();
        ctx.fillStyle = `rgba(20,28,40,${0.85 * fade})`;
        ctx.font = "700 10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        if (r > 10) ctx.fillText(String(Math.max(0, Math.ceil(total - dt))), x, y);
      } else if (g.type === "molotov" && tick < end) {
        const flick = o.still ? 0 : Math.sin(o.now / 90 + g.id) * 0.08;
        const r = 120 * S;
        const grd = ctx.createRadialGradient(x, y, 1, x, y, r);
        grd.addColorStop(0, `rgba(255,190,70,${0.75 + flick})`);
        grd.addColorStop(0.6, "rgba(255,110,30,0.55)");
        grd.addColorStop(1, "rgba(255,70,20,0.12)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,150,50,0.9)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else if (g.type === "flash" && dt < 0.45) {
        const k = dt / 0.45;
        ctx.strokeStyle = `rgba(255,250,170,${1 - k})`;
        ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath();
        ctx.arc(x, y, (10 + 40 * k) * Math.max(0.7, Math.min(1.5, S * 8)), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,255,210,${0.5 * (1 - k)})`;
        ctx.fill();
      } else if (g.type === "he" && dt < 0.55) {
        const k = dt / 0.55;
        const r = 190 * S * (0.3 + 0.7 * k);
        ctx.fillStyle = `rgba(255,120,70,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,170,110,${1 - k})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // ---- grenades in flight (trail + head)
    for (const g of m.grenadesByRound[ri]) {
      const p = grenadePos(g, tick);
      if (!p) continue;
      if (g.detonateTick != null && tick >= g.detonateTick) continue;
      const col = GRENADE_COLORS[g.type] ?? "#fff";
      const t = g.trajectory;
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X(t[1]), Y(t[2]));
      for (let i = 1; i < t.length / 4; i++) {
        if (t[i * 4] > tick) break;
        ctx.lineTo(X(t[i * 4 + 1]), Y(t[i * 4 + 2]));
      }
      ctx.lineTo(X(p[0]), Y(p[1]));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(X(p[0]), Y(p[1]), 3.5 + Math.max(0, Math.min(2, p[2] / 200)), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ---- bomb
    const bomb = m.bombState(tick);
    if (bomb.pos && (bomb.kind === "planted" || bomb.kind === "dropped" || bomb.kind === "defused" || bomb.kind === "exploded")) {
      const bx = X(bomb.pos[0]),
        by = Y(bomb.pos[1]);
      if (bomb.kind === "planted") {
        const el = (tick - bomb.plantedTick) / tr;
        const left = Math.max(0, 40 - el);
        const pulse = o.still ? 0.5 : 0.5 + 0.5 * Math.sin(o.now / (left < 10 ? 90 : 250));
        ctx.strokeStyle = `rgba(255,80,80,${0.35 + pulse * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, 16 + pulse * 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "#ff5c6c";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(bx, by, 12, -Math.PI / 2, -Math.PI / 2 + (left / 40) * Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#ff5c6c";
        ctx.fillRect(bx - 4, by - 4, 8, 8);
        ctx.fillStyle = "#fff";
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`${Math.ceil(left)} sn`, bx, by + 20);
      } else if (bomb.kind === "dropped") {
        ctx.fillStyle = "#ff9b2f";
        ctx.fillRect(bx - 4, by - 4, 8, 8);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.strokeRect(bx - 4, by - 4, 8, 8);
      } else if (bomb.kind === "exploded") {
        ctx.fillStyle = "rgba(255,120,60,0.35)";
        ctx.beginPath();
        ctx.arc(bx, by, 30, 0, Math.PI * 2);
        ctx.fill();
      } else if (bomb.kind === "defused") {
        ctx.strokeStyle = "#3ddc84";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(bx, by, 12, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    void bs;

    // ---- tracers (shots) + kill lines
    const shots = m.demo.shots ?? [];
    const win = 0.18 * tr;
    ctx.lineWidth = 1.5;
    // shots are time-sorted usually; binary scan from end window
    for (const sh of shots) {
      if (sh.tick > tick || tick - sh.tick > win) continue;
      const ps = m.sample(sh.tick, sh.player, pstates[10]);
      if (!isAlive(ps) && ps.health <= 0) continue;
      const a = 1 - (tick - sh.tick) / win;
      const yaw = (ps.yaw * Math.PI) / 180;
      const len = 700;
      ctx.strokeStyle = `rgba(255,236,160,${0.75 * a})`;
      ctx.beginPath();
      ctx.moveTo(X(ps.x), Y(ps.y));
      ctx.lineTo(X(ps.x + Math.cos(yaw) * len), Y(ps.y + Math.sin(yaw) * len));
      ctx.stroke();
    }
    for (const k of m.killsByRound[ri]) {
      const age = (tick - k.tick) / tr;
      if (age < 0 || age > 0.7) continue;
      if (k.attackerPos) {
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - age / 0.7)})`;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(X(k.attackerPos[0]), Y(k.attackerPos[1]));
        ctx.lineTo(X(k.victimPos[0]), Y(k.victimPos[1]));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ---- players
    const speaking = o.speaking;
    const dead: { x: number; y: number; side: Side; slot: number }[] = [];
    const live: number[] = [];
    for (let s = 0; s < m.pc; s++) {
      const ps = m.sample(tick, s, pstates[s]);
      if (!has(ps.flags, FrameFlag.Connected) && ps.flags === 0) continue;
      if (isAlive(ps)) live.push(s);
      else {
        // dead this round: X at last position
        dead.push({ x: ps.x, y: ps.y, side: has(ps.flags, FrameFlag.SideCT) ? "CT" : "T", slot: s });
      }
    }
    // dead markers use the position of their death (kill victimPos is exact)
    for (const d of dead) {
      const k = m.killsByRound[ri].find((q) => q.victim === d.slot && q.tick <= tick);
      const px = k ? k.victimPos[0] : d.x;
      const py = k ? k.victimPos[1] : d.y;
      if (!k && !has(pstates[d.slot].flags, FrameFlag.Connected)) continue;
      const x = X(px),
        y = Y(py);
      const col = SIDE_COLOR[d.side];
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (o.labels && S > 0.05) {
        ctx.fillStyle = "rgba(200,210,225,0.55)";
        ctx.font = "500 9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(m.players[d.slot].name, x, y + 8);
      }
    }
    for (const s of live) {
      const ps = pstates[s];
      const side: Side = has(ps.flags, FrameFlag.SideCT) ? "CT" : "T";
      const col = SIDE_COLOR[side];
      const x = X(ps.x),
        y = Y(ps.y);
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
      let alpha = 1;
      if (m.demo.map.lowerLevelMaxZ != null && o.level !== "all") {
        const lower = ps.z < m.demo.map.lowerLevelMaxZ;
        if ((o.level === "lower") !== lower) alpha = 0.3;
      }
      ctx.globalAlpha = alpha;
      const yaw = (ps.yaw * Math.PI) / 180;
      const ang = -yaw; // canvas y is flipped
      // view cone
      const cone = 44;
      const grd = ctx.createRadialGradient(x, y, 2, x, y, cone);
      grd.addColorStop(0, col + "aa");
      grd.addColorStop(1, col + "00");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, cone, ang - 0.5, ang + 0.5);
      ctx.closePath();
      ctx.fill();
      if (has(ps.flags, FrameFlag.Scoped)) {
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * 90, y + Math.sin(ang) * 90);
        ctx.stroke();
      }
      // speaking
      if (speaking.has(s)) {
        const pulse = o.still ? 0.5 : 0.5 + 0.5 * Math.sin(o.now / 120);
        ctx.strokeStyle = `rgba(61,220,132,${0.5 + 0.5 * pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 14 + pulse * 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      // blind
      if (ps.flash > 0.05) {
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.9, 0.4 + ps.flash / 4)})`;
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fill();
      }
      // body
      const r = has(ps.flags, FrameFlag.Ducking) ? 6 : 7;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = s === o.selected ? "#ffffff" : "rgba(8,12,20,0.9)";
      ctx.lineWidth = s === o.selected ? 2.4 : 1.5;
      ctx.stroke();
      // health ring
      const hp = Math.max(0, Math.min(1, ps.health / 100));
      ctx.strokeStyle = hp > 0.5 ? "#3ddc84" : hp > 0.25 ? "#ffcc4d" : "#ff5c6c";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 3.5, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2);
      ctx.stroke();
      // direction nub
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x + Math.cos(ang) * (r - 1), y + Math.sin(ang) * (r - 1), 1.8, 0, Math.PI * 2);
      ctx.fill();
      // bomb / defuser
      if (has(ps.flags, FrameFlag.HasBomb)) {
        ctx.fillStyle = "#ff5c6c";
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
      if (has(ps.flags, FrameFlag.Defusing)) {
        ctx.strokeStyle = "#35d0ba";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r + 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      // label
      if (o.labels) {
        ctx.font = `${s === o.selected ? 700 : 600} 10.5px system-ui, 'Segoe UI', sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const name = m.players[s].name;
        const tw = ctx.measureText(name).width;
        ctx.fillStyle = "rgba(8,12,20,0.7)";
        ctx.fillRect(x - tw / 2 - 3, y + r + 6, tw + 6, 13);
        ctx.fillStyle = s === o.selected ? "#fff" : "#dbe4f0";
        ctx.fillText(name, x, y + r + 7);
        const wn = weaponLabel(m.weaponName(ps.weapon));
        if (wn && wn !== "—") {
          ctx.font = "500 9px system-ui, sans-serif";
          ctx.fillStyle = "rgba(170,185,205,0.9)";
          ctx.fillText(wn, x, y + r + 20);
        }
      }
      ctx.globalAlpha = 1;
    }

    // ---- focus pulse
    if (o.focus) {
      const age = (o.now - o.focus.ts) / 1000;
      if (age < 3.5) {
        const k = (age % 1.2) / 1.2;
        ctx.strokeStyle = `rgba(53,208,186,${1 - k})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(X(o.focus.pos[0]), Y(o.focus.pos[1]), 8 + k * 30, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#35d0ba";
        ctx.beginPath();
        ctx.arc(X(o.focus.pos[0]), Y(o.focus.pos[1]), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---- coach overlay
  if (o.coach) drawCoach2D(ctx, o.coach, X, Y, S, m);

  ctx.restore();
  if (o.feed !== false && round) drawKillFeed(ctx, m, m.killsByRound[ri], tick, w);
  if (o.hud !== false && round) drawHud(ctx, m, tick, w);
}

const heatCache = new Map<string, HTMLCanvasElement>();
function heatCanvas(layer: HeatLayer, view: View2D, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.floor(w));
  cv.height = Math.max(1, Math.floor(h));
  const c = cv.getContext("2d")!;
  c.globalCompositeOperation = "lighter";
  const [r, g, b] = layer.color;
  for (const p of layer.points) {
    const x = w / 2 + (p.x - view.cx) * view.s;
    const y = h / 2 - (p.y - view.cy) * view.s;
    const grd = c.createRadialGradient(x, y, 0, x, y, layer.radius);
    const a = 0.22 * (p.w ?? 1);
    grd.addColorStop(0, `rgba(${r},${g},${b},${a})`);
    grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
    c.fillStyle = grd;
    c.fillRect(x - layer.radius, y - layer.radius, layer.radius * 2, layer.radius * 2);
  }
  void heatCache;
  return cv;
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(a - 0.4) * 9, y1 - Math.sin(a - 0.4) * 9);
  ctx.lineTo(x1 - Math.cos(a + 0.4) * 9, y1 - Math.sin(a + 0.4) * 9);
  ctx.closePath();
  ctx.fill();
}

function tag(ctx: CanvasRenderingContext2D, x: number, y: number, lines: string[], color: string, align: CanvasTextAlign = "left") {
  ctx.font = "600 11px system-ui, 'Segoe UI', sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = align;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const tw = Math.max(...widths) + 12;
  const th = lines.length * 14 + 6;
  const bx = align === "left" ? x : align === "right" ? x - tw : x - tw / 2;
  ctx.fillStyle = "rgba(8,12,20,0.88)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, y, tw, th, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e8eef7";
  lines.forEach((l, i) => ctx.fillText(l, align === "left" ? x + 6 : align === "right" ? x - 6 : x, y + 4 + i * 14));
}

export function drawCoach2D(ctx: CanvasRenderingContext2D, c: CoachOverlay, X: (v: number) => number, Y: (v: number) => number, S: number, m: Match) {
  const g = c.grenade;
  const s = c.suggestion;
  const RED = "#ff6b6b",
    GREEN = "#3ddc84";
  // actual
  if (g) {
    const t = g.trajectory;
    ctx.strokeStyle = RED;
    ctx.lineWidth = 2.4;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = 0; i < t.length / 4; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(t[i * 4 + 1]), Y(t[i * 4 + 2]));
    ctx.stroke();
    ctx.fillStyle = RED;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(X(g.throwPos[0]), Y(g.throwPos[1]), 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (g.detonatePos) {
      const lx = X(g.detonatePos[0]),
        ly = Y(g.detonatePos[1]);
      ctx.strokeStyle = RED;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(lx - 7, ly - 7);
      ctx.lineTo(lx + 7, ly + 7);
      ctx.moveTo(lx + 7, ly - 7);
      ctx.lineTo(lx - 7, ly + 7);
      ctx.stroke();
      tag(ctx, lx + 10, ly + 6, ["Gerçek düşüş", g.landPlace ?? "—"], RED);
    }
    tag(ctx, X(g.throwPos[0]) + 10, Y(g.throwPos[1]) - 34, [`Gerçek atış · ${styleLabel(g.throwStyle)}`, `Yaw ${g.throwYaw.toFixed(1)}° Pitch ${g.throwPitch.toFixed(1)}°`], RED);
  }
  // suggested
  const t = s.trajectory;
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 2.4;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  for (let i = 0; i < t.length / 3; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(t[i * 3]), Y(t[i * 3 + 1]));
  ctx.stroke();
  ctx.setLineDash([]);
  const fx = X(s.from[0]),
    fy = Y(s.from[1]);
  ctx.fillStyle = GREEN;
  // stand marker: ring + dot
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(fx, fy, 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(fx, fy, 4, 0, Math.PI * 2);
  ctx.fill();
  const yaw = (s.aimYaw * Math.PI) / 180;
  ctx.lineWidth = 2;
  arrow(ctx, fx + Math.cos(yaw) * 12, fy - Math.sin(yaw) * 12, fx + Math.cos(yaw) * 46, fy - Math.sin(yaw) * 46);
  const lx = X(s.land[0]),
    ly = Y(s.land[1]);
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(lx, ly, Math.max(8, 70 * S), 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fill();
  tag(ctx, lx + 12, ly - 28, ["Önerilen düşüş", s.landPlace ?? "—"], GREEN);
  tag(
    ctx,
    fx + 12,
    fy + 10,
    [`Önerilen: ${s.fromPlace ?? "—"} · ${styleLabel(s.throwStyle)}`, `Yaw ${s.aimYaw.toFixed(1)}° Pitch ${s.aimPitch.toFixed(1)}°`, `Kaynak: ${sourceLabel(s.source)} (${s.support} atış)`],
    GREEN,
  );
  void m;
}
export const sourceLabel = (s: string) => (s === "seed" ? "Hazır liste" : s === "library" ? "Kütüphane" : s === "this_demo" ? "Bu demo" : s);

export function drawKillFeed(ctx: CanvasRenderingContext2D, m: Match, kills: KillEvent[], tick: number, w: number) {
  const tr = m.tickRate;
  const recent = kills.filter((k) => k.tick <= tick && tick - k.tick < 7 * tr).slice(-6);
  ctx.font = "600 11.5px system-ui, 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  let y = 14;
  for (const k of recent) {
    const age = (tick - k.tick) / tr;
    const a = age > 6 ? 1 - (age - 6) : 1;
    const an = k.attacker != null ? m.players[k.attacker].name : "Dünya";
    const vn = m.players[k.victim].name;
    const wn = weaponLabel(k.weapon) + (k.headshot ? " ⌖" : "") + (k.wallbang ? " ▤" : "") + (k.throughSmoke ? " ☁" : "");
    const aSide = k.attacker != null ? m.sideInRound(k.attacker, k.round) : "T";
    const vSide = m.sideInRound(k.victim, k.round);
    const parts = [
      { t: an, c: SIDE_COLOR[aSide] },
      { t: wn, c: "#c9d3e2" },
      { t: vn, c: SIDE_COLOR[vSide] },
    ];
    let tw = 0;
    const ws = parts.map((p) => {
      const x = ctx.measureText(p.t).width;
      tw += x + 10;
      return x;
    });
    const x0 = w - tw - 10;
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = "rgba(8,12,20,0.78)";
    ctx.beginPath();
    ctx.roundRect(x0 - 4, y - 10, tw + 4, 20, 4);
    ctx.fill();
    let x = x0 + 2;
    ctx.textAlign = "left";
    parts.forEach((p, i) => {
      ctx.fillStyle = p.c;
      ctx.fillText(p.t, x, y);
      x += ws[i] + 10;
    });
    ctx.globalAlpha = 1;
    y += 23;
  }
}

export function drawHud(ctx: CanvasRenderingContext2D, m: Match, tick: number, w: number) {
  const r = m.roundAt(tick);
  if (!r) return;
  const sec = (tick - r.freezeEndTick) / m.tickRate;
  const bomb = m.bombState(tick);
  let label = sec < 0 ? "Hazırlık" : fmtClock(Math.min(115, sec));
  if (bomb.kind === "planted") label = `Bomba ${Math.max(0, Math.ceil(40 - (tick - bomb.plantedTick) / m.tickRate))}`;
  // alive counts
  const ps = newPState();
  let ct = 0,
    t = 0;
  for (let s = 0; s < m.pc; s++) {
    m.sample(tick, s, ps);
    if (isAlive(ps)) has(ps.flags, FrameFlag.SideCT) ? ct++ : t++;
  }
  const sb = r.scoreBefore;
  const ctTeam = r.teamSides[0] === "CT" ? 0 : 1;
  const tTeam = 1 - ctTeam;
  ctx.save();
  const cx = w / 2;
  ctx.fillStyle = "rgba(8,12,20,0.82)";
  ctx.beginPath();
  ctx.roundRect(cx - 118, 8, 236, 36, 8);
  ctx.fill();
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.font = "800 17px system-ui, sans-serif";
  ctx.fillStyle = SIDE_COLOR.CT;
  ctx.fillText(String(sb[ctTeam]), cx - 98, 27);
  ctx.fillStyle = SIDE_COLOR.T;
  ctx.fillText(String(sb[tTeam]), cx + 98, 27);
  ctx.fillStyle = "#e8eef7";
  ctx.font = "700 15px ui-monospace, 'SF Mono', Menlo, monospace";
  ctx.fillText(label, cx, 21);
  ctx.font = "600 9.5px system-ui, sans-serif";
  ctx.fillStyle = "#8a99b0";
  ctx.fillText(`Raunt ${r.number}`, cx, 36);
  ctx.font = "700 12px system-ui, sans-serif";
  ctx.fillStyle = SIDE_COLOR.CT;
  ctx.fillText(`${ct}`, cx - 64, 27);
  ctx.fillStyle = SIDE_COLOR.T;
  ctx.fillText(`${t}`, cx + 64, 27);
  ctx.restore();
}
