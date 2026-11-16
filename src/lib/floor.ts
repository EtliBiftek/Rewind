import type { Match } from "./model";

/** Walkable-floor model reconstructed from sampled player positions. */
export interface FloorLevel {
  /** 0/1 walkable mask after dilation. */
  walk: Uint8Array;
  /** Smoothed density 0..1 (visit frequency) */
  dens: Float32Array;
  /** Soft alpha 0..1 for rendering. */
  alpha: Float32Array;
  /** Floor height per cell (valid where walk=1). */
  z: Float32Array;
}
export interface Floor {
  cell: number;
  ox: number; // world x of cell column 0 left edge
  oy: number; // world y of row 0 BOTTOM edge (rows grow with +y)
  w: number;
  h: number;
  levels: FloorLevel[]; // [upper] or [upper, lower]
  zMin: number;
  zMax: number;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number, passes = 1): Float32Array {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    a = out;
  }
  return a;
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function buildFloor(m: Match): Floor {
  const map = m.demo.map;
  const bmin = map.boundsMin ?? [0, 0, 0];
  const bmax = map.boundsMax ?? [1, 1, 1];
  // robust bounds from actual samples (ignore NaN/zero-only)
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  const d = m.frames;
  const stride = m.stride;
  const total = m.fc * m.pc;
  for (let i = 0; i < total; i++) {
    const o = i * stride;
    const fl = d[o + 7];
    if (!(fl & 2)) continue;
    const x = d[o],
      y = d[o + 1],
      z = d[o + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) {
    minX = bmin[0];
    minY = bmin[1];
    maxX = bmax[0];
    maxY = bmax[1];
    minZ = bmin[2];
    maxZ = bmax[2];
  }
  const pad = 160;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const ext = Math.max(maxX - minX, maxY - minY, 500);
  const cell = Math.min(48, Math.max(20, ext / 230));
  const w = Math.ceil((maxX - minX) / cell) + 1;
  const h = Math.ceil((maxY - minY) / cell) + 1;
  const nLevels = map.lowerLevelMaxZ != null ? 2 : 1;
  const cnt = Array.from({ length: nLevels }, () => new Float32Array(w * h));
  const zs = Array.from({ length: nLevels }, () => new Float32Array(w * h));
  for (let i = 0; i < total; i++) {
    const o = i * stride;
    if (!(d[o + 7] & 2)) continue;
    const x = d[o],
      y = d[o + 1],
      z = d[o + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const cx = Math.floor((x - minX) / cell);
    const cy = Math.floor((y - minY) / cell);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    const lv = nLevels === 2 && z < (map.lowerLevelMaxZ as number) ? 1 : 0;
    cnt[lv][cy * w + cx]++;
    zs[lv][cy * w + cx] += z;
  }
  const levels: FloorLevel[] = [];
  for (let lv = 0; lv < nLevels; lv++) {
    const c = cnt[lv];
    const occ = new Float32Array(w * h);
    const logc = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (c[i] > 0) occ[i] = 1;
      logc[i] = Math.log1p(c[i]);
    }
    const field = boxBlur(occ, w, h, 2, 2);
    const walk = new Uint8Array(w * h);
    const alpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      walk[i] = field[i] > 0.1 ? 1 : 0;
      alpha[i] = smooth(0.06, 0.3, field[i]);
    }
    const dl = boxBlur(logc, w, h, 3, 2);
    let mx = 0;
    for (let i = 0; i < dl.length; i++) mx = Math.max(mx, dl[i]);
    const dens = new Float32Array(w * h);
    for (let i = 0; i < dl.length; i++) dens[i] = mx > 0 ? dl[i] / mx : 0;
    // heights: observed mean, then fill by neighbour propagation
    const z = new Float32Array(w * h);
    const known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (c[i] > 0) {
        z[i] = zs[lv][i] / c[i];
        known[i] = 1;
      }
    }
    for (let it = 0; it < 8; it++) {
      const nk = known.slice();
      const nz = z.slice();
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (known[i] || !walk[i]) continue;
          let s = 0,
            n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx,
                yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const j = yy * w + xx;
              if (known[j]) {
                s += z[j];
                n++;
              }
            }
          if (n) {
            nz[i] = s / n;
            nk[i] = 1;
          }
        }
      z.set(nz);
      known.set(nk);
    }
    // smooth heights over walkable neighbours
    for (let pass = 0; pass < 2; pass++) {
      const nz = z.slice();
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!walk[i]) continue;
          let s = z[i] * 2,
            n = 2;
          for (const j of [i - 1, i + 1, i - w, i + w]) if (walk[j]) {
            s += z[j];
            n++;
          }
          nz[i] = s / n;
        }
      z.set(nz);
    }
    levels.push({ walk, dens, alpha, z });
  }
  return { cell, ox: minX, oy: minY, w, h, levels, zMin: Number.isFinite(minZ) ? minZ : 0, zMax: Number.isFinite(maxZ) ? maxZ : 0 };
}

/** Render a level to a canvas at grid resolution (soft edges, rim, density shading). North up (row 0 = max y). */
export function rasterizeLevel(f: Floor, lv: number, fill: [number, number, number], rim: [number, number, number]): HTMLCanvasElement {
  const L = f.levels[lv];
  const cv = document.createElement("canvas");
  cv.width = f.w;
  cv.height = f.h;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(f.w, f.h);
  const blurred = boxBlur(L.alpha, f.w, f.h, 2, 1);
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x; // row y = world row y
      const o = ((f.h - 1 - y) * f.w + x) * 4; // flip: image row 0 = north
      const a = L.alpha[i];
      const edge = Math.max(0, Math.min(1, (a - blurred[i]) * 3.2 + (a > 0.5 && blurred[i] < 0.8 ? 0.35 : 0)));
      const shade = 0.78 + 0.22 * L.dens[i];
      let r = fill[0] * shade,
        g = fill[1] * shade,
        b = fill[2] * shade;
      r += (rim[0] - r) * edge;
      g += (rim[1] - g) * edge;
      b += (rim[2] - b) * edge;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = Math.round(255 * Math.min(1, a * (0.92 + edge * 0.08)));
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
