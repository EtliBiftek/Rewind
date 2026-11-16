import * as THREE from "three";
import { FrameFlag, type Grenade, type UtilitySuggestion } from "../lib/contract";
import { GRENADE_COLORS, Match, SIDE_COLOR, grenadeEnd, has, isAlive, newPState, styleLabel, weaponLabel, type PState } from "../lib/model";
import type { CoachOverlay } from "./draw2d";
import type { RealMapAsset } from "./realmap";
import { ViewModel, type ActorLibrary, type Character } from "./actors";

export type CamMode = "pov" | "chase" | "free" | "top";
export interface FreeCam {
  x: number;
  y: number;
  z: number;
  yaw: number; // degrees, world convention
  pitch: number;
}
export interface TopCam {
  cx: number;
  cy: number;
  h: number;
}
export interface CamSpec {
  mode: CamMode;
  selected: number;
  free: FreeCam;
  top: TopCam;
  w: number;
  h: number;
}

const DEG = Math.PI / 180;
const WALL_H = 135;

function softTexture(kind: "smoke" | "fire" | "glow"): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  if (kind === "smoke") {
    grd.addColorStop(0, "rgba(255,255,255,0.95)");
    grd.addColorStop(0.5, "rgba(235,240,248,0.55)");
    grd.addColorStop(1, "rgba(220,228,240,0)");
  } else if (kind === "fire") {
    grd.addColorStop(0, "rgba(255,240,170,1)");
    grd.addColorStop(0.4, "rgba(255,150,40,0.7)");
    grd.addColorStop(1, "rgba(255,60,10,0)");
  } else {
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.3, "rgba(255,255,255,0.5)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
  }
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelSprite(lines: string[], color: string, scale = 1): THREE.Sprite {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = "600 26px system-ui, 'Segoe UI', sans-serif";
  const wmax = Math.max(...lines.map((l) => g.measureText(l).width)) + 28;
  c.width = Math.ceil(wmax);
  c.height = lines.length * 34 + 16;
  const g2 = c.getContext("2d")!;
  g2.font = "600 26px system-ui, 'Segoe UI', sans-serif";
  g2.fillStyle = "rgba(8,12,20,0.88)";
  g2.strokeStyle = color;
  g2.lineWidth = 3;
  g2.beginPath();
  g2.roundRect(2, 2, c.width - 4, c.height - 4, 10);
  g2.fill();
  g2.stroke();
  g2.fillStyle = "#eef3fa";
  g2.textBaseline = "top";
  lines.forEach((l, i) => g2.fillText(l, 14, 10 + i * 34));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
  const k = 0.42 * scale;
  sp.scale.set(c.width * k, c.height * k, 1);
  sp.renderOrder = 20;
  return sp;
}

interface PlayerVis {
  group: THREE.Group;
  upper: THREE.Group;
  legs: THREE.Group;
  gun: THREE.Group;
  pack: THREE.Mesh;
  bodyMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  tag: THREE.Sprite;
  tagKey: string;
  tagCanvas: HTMLCanvasElement;
  cross: THREE.Group;
  disc: THREE.Mesh;
}

interface GrenVis {
  g: Grenade;
  ball: THREE.Mesh;
  trail: THREE.Line;
  fx: THREE.Group | null;
  sprites: THREE.Sprite[];
}

/** Standing / crouched player height in Source units (CS2 hull: 72 / 54). */
export const PLAYER_H = 72;
export const PLAYER_H_DUCK = 54;
/** CS2 view offsets (eye height above the feet). */
export const EYE_H = 64;
export const EYE_H_DUCK = 46;
/** The stylised player model is authored ~78 units tall; scaled to the real hull height. */
const MODEL_TOP = 78;

export class Scene3D {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, 16 / 9, 2, 40000);
  match: Match;
  renderer: THREE.WebGLRenderer;
  players: PlayerVis[] = [];
  tmp: PState[] = Array.from({ length: 16 }, newPState);
  grens = new Map<number, GrenVis>();
  curRound = -2;
  tracers: THREE.Mesh[] = [];
  bomb: THREE.Group;
  bombLed: THREE.Mesh;
  bombDropped: THREE.Mesh;
  coachGroup: THREE.Group | null = null;
  coachKey = "";
  view: THREE.Group;
  viewGun: THREE.Mesh;
  smokeTex = softTexture("smoke");
  fireTex = softTexture("fire");
  glowTex = softTexture("glow");
  floorGroup = new THREE.Group();
  focusMarker: THREE.Mesh;
  boundsCenter = new THREE.Vector3();
  boundsSize = 4000;
  time = 0;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  /** The real map currently shown (null = reconstructed floor). */
  realMap: RealMapAsset | null = null;
  private realRoot: THREE.Object3D | null = null;
  private sky: THREE.Mesh | null = null;
  private shadowHalf = 0;
  private clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  /** The game's agents / weapons / animations (null = stylised players). */
  actors: ActorLibrary | null = null;
  private chars = new Map<string, Character>();
  private vm: ViewModel | null = null;
  private vmOn = false;
  private flashes: THREE.Sprite[] = [];
  private lastNow = 0;

  constructor(match: Match, renderer: THREE.WebGLRenderer) {
    this.match = match;
    this.renderer = renderer;
    const sc = this.scene;
    sc.background = new THREE.Color(0x0a1019);
    sc.fog = new THREE.FogExp2(0x0a1019, 0.00011);
    this.hemi = new THREE.HemisphereLight(0xb6ccff, 0x1b2433, 1.15);
    sc.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff0dc, 1.5);
    sun.position.set(-1200, 2400, 900);
    this.sun = sun;
    sc.add(sun, sun.target);
    this.ambient = new THREE.AmbientLight(0x405070, 0.5);
    sc.add(this.ambient);
    sc.add(this.camera);
    sc.add(this.floorGroup);
    this.buildWorld();
    for (let i = 0; i < match.pc; i++) this.players.push(this.makePlayer(i));
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.7, 1, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      m.visible = false;
      sc.add(m);
      this.tracers.push(m);
    }
    this.bomb = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(26, 10, 18), new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6 }));
    body.position.y = 5;
    this.bomb.add(body);
    this.bombLed = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
    this.bombLed.position.set(8, 11, 0);
    this.bomb.add(this.bombLed);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xff3030, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.set(60, 60, 1);
    glow.position.set(8, 12, 0);
    this.bomb.add(glow);
    this.bomb.visible = false;
    sc.add(this.bomb);
    this.bombDropped = new THREE.Mesh(new THREE.BoxGeometry(18, 8, 12), new THREE.MeshStandardMaterial({ color: 0xff9b2f, emissive: 0x553000 }));
    this.bombDropped.visible = false;
    sc.add(this.bombDropped);
    this.focusMarker = new THREE.Mesh(new THREE.TorusGeometry(26, 2.4, 8, 32), new THREE.MeshBasicMaterial({ color: 0x35d0ba, transparent: true }));
    this.focusMarker.rotation.x = Math.PI / 2;
    this.focusMarker.visible = false;
    sc.add(this.focusMarker);
    // first-person view model
    this.view = new THREE.Group();
    this.viewGun = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3, 14), new THREE.MeshStandardMaterial({ color: 0x20252d, roughness: 0.5, metalness: 0.4 }));
    this.viewGun.position.set(8.8, -8.6, -26);
    this.view.add(this.viewGun);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0xc9a07a, roughness: 0.8 }));
    arm.position.set(9, -10.6, -17);
    arm.rotation.x = 0.15;
    this.view.add(arm);
    this.view.visible = false;
    this.camera.add(this.view);
    for (let i = 0; i < 12; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffc46a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      sp.visible = false;
      sc.add(sp);
      this.flashes.push(sp);
    }
  }

  /** Shows the game's own player models and animations (null = back to the stylised players). Shared library, own instances. */
  setActors(lib: ActorLibrary | null) {
    for (const c of this.chars.values()) c.dispose();
    this.chars.clear();
    this.actors = lib;
    this.vm = lib ? new ViewModel(lib) : null;
  }

  private character(slot: number, side: "CT" | "T"): Character | null {
    if (!this.actors) return null;
    const k = `${slot}|${side}`;
    let c = this.chars.get(k);
    if (!c) {
      c = this.actors.makeCharacter(side);
      this.chars.set(k, c);
      this.scene.add(c.root);
    }
    return c;
  }

  /** World (Source) -> three coordinates. */
  static v(x: number, y: number, z: number, out = new THREE.Vector3()) {
    return out.set(x, z, -y);
  }

  private buildWorld() {
    const m = this.match;
    const f = m.floor;
    const zr = Math.max(1, f.zMax - f.zMin);
    const cx = f.ox + (f.w * f.cell) / 2;
    const cy = f.oy + (f.h * f.cell) / 2;
    this.boundsCenter.set(cx, (f.zMin + f.zMax) / 2, -cy);
    this.boundsSize = Math.max(f.w, f.h) * f.cell;
    const col = new THREE.Color();
    for (let lv = 0; lv < f.levels.length; lv++) {
      const L = f.levels[lv];
      const W1 = f.w + 1;
      const H1 = f.h + 1;
      const pos = new Float32Array(W1 * H1 * 3);
      const colors = new Float32Array(W1 * H1 * 3);
      const vz = new Float32Array(W1 * H1);
      for (let vy = 0; vy < H1; vy++)
        for (let vx = 0; vx < W1; vx++) {
          let s = 0,
            n = 0,
            dsum = 0;
          for (let dy = -1; dy <= 0; dy++)
            for (let dx = -1; dx <= 0; dx++) {
              const x = vx + dx,
                y = vy + dy;
              if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
              const i = y * f.w + x;
              if (L.walk[i]) {
                s += L.z[i];
                dsum += L.dens[i];
                n++;
              }
            }
          const i = vy * W1 + vx;
          const z = n ? s / n : f.zMin;
          vz[i] = z;
          pos[i * 3] = f.ox + vx * f.cell;
          pos[i * 3 + 1] = z;
          pos[i * 3 + 2] = -(f.oy + vy * f.cell);
          const hn = (z - f.zMin) / zr;
          const dn = n ? dsum / n : 0;
          const checker = (vx + vy) & 1 ? 0.025 : -0.025;
          const base = lv === 0 ? [0.15, 0.23, 0.32] : [0.2, 0.19, 0.34];
          const lum = 0.7 + hn * 0.4 + dn * 0.25 + checker;
          col.setRGB(base[0] * lum, base[1] * lum, base[2] * lum);
          colors[i * 3] = col.r;
          colors[i * 3 + 1] = col.g;
          colors[i * 3 + 2] = col.b;
        }
      const idx: number[] = [];
      for (let y = 0; y < f.h; y++)
        for (let x = 0; x < f.w; x++) {
          if (!L.walk[y * f.w + x]) continue;
          const a = y * W1 + x,
            b = a + 1,
            c = a + W1,
            d = c + 1;
          // counter-clockwise seen from +Y (up): three z = -worldY
          idx.push(a, c, b, b, c, d);
        }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
      this.floorGroup.add(mesh);

      // walls along walkable boundaries
      const wp: number[] = [];
      const wc: number[] = [];
      const lp: number[] = [];
      const top = new THREE.Color(0.13, 0.17, 0.25);
      const bot = new THREE.Color(0.24, 0.31, 0.42);
      const edge = (x0: number, y0: number, x1: number, y1: number) => {
        const i0 = y0 * W1 + x0,
          i1 = y1 * W1 + x1;
        const p0 = [f.ox + x0 * f.cell, -(f.oy + y0 * f.cell)];
        const p1 = [f.ox + x1 * f.cell, -(f.oy + y1 * f.cell)];
        const z0 = vz[i0],
          z1 = vz[i1];
        // inward-facing quad (back-face culled when seen from outside => cut-away look)
        wp.push(p0[0], z0, p0[1], p1[0], z1 + WALL_H, p1[1], p1[0], z1, p1[1], p0[0], z0, p0[1], p0[0], z0 + WALL_H, p0[1], p1[0], z1 + WALL_H, p1[1]);
        wc.push(bot.r, bot.g, bot.b, top.r, top.g, top.b, bot.r, bot.g, bot.b, bot.r, bot.g, bot.b, top.r, top.g, top.b, top.r, top.g, top.b);
        lp.push(p0[0], z0 + WALL_H, p0[1], p1[0], z1 + WALL_H, p1[1]);
      };
      const wk = (x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h && L.walk[y * f.w + x] === 1;
      for (let y = 0; y < f.h; y++)
        for (let x = 0; x < f.w; x++) {
          if (!wk(x, y)) continue;
          // order chosen so the outward face winds correctly; material is double sided anyway
          if (!wk(x - 1, y)) edge(x, y + 1, x, y);
          if (!wk(x + 1, y)) edge(x + 1, y, x + 1, y + 1);
          if (!wk(x, y - 1)) edge(x, y, x + 1, y);
          if (!wk(x, y + 1)) edge(x + 1, y + 1, x, y + 1);
        }
      if (wp.length) {
        const wg = new THREE.BufferGeometry();
        wg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(wp), 3));
        wg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(wc), 3));
        wg.computeVertexNormals();
        this.floorGroup.add(new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.FrontSide })));
        const lg = new THREE.BufferGeometry();
        lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lp), 3));
        this.floorGroup.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: lv === 0 ? 0x6f95bd : 0x9a86d0, transparent: true, opacity: 0.55 })));
      }
    }
    // far ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), new THREE.MeshBasicMaterial({ color: 0x080d14 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, f.zMin - 80 + (f.levels.length === 2 ? -120 : 0), -cy);
    this.floorGroup.add(ground);
    // subtle grid on the ground
    const grid = new THREE.GridHelper(Math.ceil(this.boundsSize / 256) * 256 + 1024, Math.ceil(this.boundsSize / 256) * 2 + 8, 0x1a2638, 0x121b29);
    grid.position.set(cx, f.zMin - 78 + (f.levels.length === 2 ? -120 : 0), -cy);
    this.floorGroup.add(grid);
  }

  private makePlayer(slot: number): PlayerVis {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xd9b08c, roughness: 0.8 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b2028, roughness: 0.8 });
    const legs = new THREE.Group();
    for (const z of [-6, 6]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(9, 32, 9), darkMat);
      l.position.set(0, 16, z);
      legs.add(l);
    }
    group.add(legs);
    const upper = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(14, 28, 26), bodyMat);
    torso.position.y = 46;
    upper.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(8.5, 14, 12), headMat);
    head.position.set(1, 68, 0);
    upper.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(5, 4.5, 12), darkMat);
    visor.position.set(7, 69, 0);
    upper.add(visor);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(9.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat);
    cap.position.set(1, 69, 0);
    upper.add(cap);
    const gun = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(34, 5, 5), new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.4, metalness: 0.5 }));
    barrel.position.set(18, 0, 0);
    gun.add(barrel);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(22, 6, 6), headMat);
    arm.position.set(10, -2, 7);
    gun.add(arm);
    gun.position.set(6, 52, 6);
    upper.add(gun);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(8, 14, 16), new THREE.MeshStandardMaterial({ color: 0xff5c6c, emissive: 0x551018 }));
    pack.position.set(-11, 48, 0);
    upper.add(pack);
    group.add(upper);
    group.traverse((o) => ((o as THREE.Mesh).isMesh ? (((o as THREE.Mesh).castShadow = true), ((o as THREE.Mesh).receiveShadow = true)) : null));
    this.scene.add(group);
    // name tag
    const tagCanvas = document.createElement("canvas");
    tagCanvas.width = 256;
    tagCanvas.height = 64;
    const tex = new THREE.CanvasTexture(tagCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
    tag.scale.set(70, 17.5, 1);
    tag.renderOrder = 10;
    this.scene.add(tag);
    // death cross
    const cross = new THREE.Group();
    for (const r of [Math.PI / 4, -Math.PI / 4]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(46, 2, 7), new THREE.MeshBasicMaterial({ color: 0xff5c6c, transparent: true, opacity: 0.9 }));
      b.rotation.y = r;
      cross.add(b);
    }
    cross.visible = false;
    this.scene.add(cross);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = 5;
    this.scene.add(disc);
    return { group, upper, legs, gun, pack, bodyMat, headMat, tag, tagKey: "", tagCanvas, cross, disc };
  }

  private drawTag(pv: PlayerVis, name: string, hp: number, side: string, sel: boolean, speaking: boolean) {
    const key = `${name}|${Math.ceil(hp)}|${side}|${sel}|${speaking}`;
    if (key === pv.tagKey) return;
    pv.tagKey = key;
    const g = pv.tagCanvas.getContext("2d")!;
    g.clearRect(0, 0, 256, 64);
    g.fillStyle = "rgba(8,12,20,0.78)";
    g.beginPath();
    g.roundRect(4, 4, 248, 56, 10);
    g.fill();
    g.strokeStyle = sel ? "#fff" : speaking ? "#3ddc84" : side === "CT" ? SIDE_COLOR.CT : SIDE_COLOR.T;
    g.lineWidth = sel || speaking ? 4 : 2;
    g.stroke();
    g.fillStyle = "#f2f6fb";
    g.font = "700 26px system-ui, 'Segoe UI', sans-serif";
    g.textBaseline = "top";
    g.textAlign = "center";
    g.fillText(speaking ? `♪ ${name}` : name, 128, 9, 232);
    g.fillStyle = "#2a3446";
    g.fillRect(16, 42, 224, 9);
    g.fillStyle = hp > 50 ? "#3ddc84" : hp > 25 ? "#ffcc4d" : "#ff5c6c";
    g.fillRect(16, 42, (224 * Math.max(0, Math.min(100, hp))) / 100, 9);
    (pv.tag.material.map as THREE.Texture).needsUpdate = true;
  }

  private clearRoundObjects() {
    for (const gv of this.grens.values()) {
      this.scene.remove(gv.ball, gv.trail);
      gv.trail.geometry.dispose();
      if (gv.fx) {
        this.scene.remove(gv.fx);
        for (const s of gv.sprites) s.material.dispose();
      }
    }
    this.grens.clear();
  }

  private makeGrenVis(g: Grenade): GrenVis {
    const col = new THREE.Color(GRENADE_COLORS[g.type] ?? "#fff");
    const ball = new THREE.Mesh(new THREE.SphereGeometry(4.6, 10, 8), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4 }));
    ball.visible = false;
    const n = g.trajectory.length / 4;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = g.trajectory[i * 4 + 1];
      arr[i * 3 + 1] = g.trajectory[i * 4 + 3];
      arr[i * 3 + 2] = -g.trajectory[i * 4 + 2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    geo.setDrawRange(0, 0);
    const trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.75 }));
    trail.frustumCulled = false;
    trail.visible = false;
    this.scene.add(ball, trail);
    let fx: THREE.Group | null = null;
    const sprites: THREE.Sprite[] = [];
    if (g.detonatePos) {
      fx = new THREE.Group();
      Scene3D.v(g.detonatePos[0], g.detonatePos[1], g.detonatePos[2], fx.position);
      let cnt = 0;
      let tex = this.glowTex;
      let blend: THREE.Blending = THREE.AdditiveBlending;
      let color = 0xffffff;
      if (g.type === "smoke") {
        cnt = 18;
        tex = this.smokeTex;
        blend = THREE.NormalBlending;
        color = 0xdfe6ef;
      } else if (g.type === "molotov") {
        cnt = 14;
        tex = this.fireTex;
      } else if (g.type === "flash") cnt = 1;
      else if (g.type === "he") {
        cnt = 1;
        tex = this.fireTex;
      }
      for (let i = 0; i < cnt; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, blending: blend }));
        sprites.push(sp);
        fx.add(sp);
      }
      fx.visible = false;
      this.scene.add(fx);
    }
    return { g, ball, trail, fx, sprites };
  }

  private rnd(i: number, k: number) {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  setCoach(c: CoachOverlay | null) {
    const key = c ? `${c.insight.id}` : "";
    if (key === this.coachKey) return;
    this.coachKey = key;
    if (this.coachGroup) {
      this.scene.remove(this.coachGroup);
      this.coachGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
      });
      this.coachGroup = null;
    }
    if (!c) return;
    const grp = new THREE.Group();
    const RED = 0xff6b6b,
      GREEN = 0x3ddc84;
    const g = c.grenade;
    const s: UtilitySuggestion = c.suggestion;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
    const ring = (p: THREE.Vector3, r: number, color: number) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, 3, 8, 40), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
      m.rotation.x = Math.PI / 2;
      m.position.copy(p).add(new THREE.Vector3(0, 3, 0));
      m.renderOrder = 15;
      return m;
    };
    const beam = (p: THREE.Vector3, color: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 160, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
      m.position.copy(p).add(new THREE.Vector3(0, 80, 0));
      return m;
    };
    if (g) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < g.trajectory.length / 4; i++) pts.push(V(g.trajectory[i * 4 + 1], g.trajectory[i * 4 + 2], g.trajectory[i * 4 + 3]));
      if (pts.length > 1) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: RED, depthTest: false }));
        line.renderOrder = 14;
        grp.add(line);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.min(80, pts.length * 3), 2.2, 6, false), new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.75 }));
        grp.add(tube);
      }
      const tp = V(g.throwPos[0], g.throwPos[1], g.throwPos[2]);
      grp.add(ring(tp, 18, RED), beam(tp, RED));
      const l1 = labelSprite([`Gerçek atış · ${styleLabel(g.throwStyle)}`, `Yaw ${g.throwYaw.toFixed(1)}°  Pitch ${g.throwPitch.toFixed(1)}°`], "#ff6b6b");
      l1.position.copy(tp).add(new THREE.Vector3(0, 190, 0));
      grp.add(l1);
      if (g.detonatePos) {
        const lp = V(g.detonatePos[0], g.detonatePos[1], g.detonatePos[2]);
        grp.add(ring(lp, 36, RED));
        const l2 = labelSprite(["Gerçek düşüş", g.landPlace ?? "—"], "#ff6b6b");
        l2.position.copy(lp).add(new THREE.Vector3(0, 90, 0));
        grp.add(l2);
      }
    }
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < s.trajectory.length / 3; i++) pts.push(V(s.trajectory[i * 3], s.trajectory[i * 3 + 1], s.trajectory[i * 3 + 2]));
    if (pts.length > 1) {
      const dl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: GREEN, dashSize: 22, gapSize: 12, depthTest: false }));
      dl.computeLineDistances();
      dl.renderOrder = 14;
      grp.add(dl);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.min(80, pts.length * 3), 1.8, 6, false), new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.55 }));
      grp.add(tube);
    }
    const fp = V(s.from[0], s.from[1], s.from[2]);
    grp.add(ring(fp, 22, GREEN), beam(fp, GREEN));
    const yaw = s.aimYaw * DEG;
    const dir = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const cone = new THREE.Mesh(new THREE.ConeGeometry(9, 30, 12), new THREE.MeshBasicMaterial({ color: GREEN }));
    cone.position.copy(fp).add(new THREE.Vector3(0, 8, 0)).addScaledVector(dir, 48);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    grp.add(cone);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 34, 6), new THREE.MeshBasicMaterial({ color: GREEN }));
    shaft.position.copy(fp).add(new THREE.Vector3(0, 8, 0)).addScaledVector(dir, 22);
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    grp.add(shaft);
    const l3 = labelSprite([s.label, `${s.fromPlace ?? "—"} · ${styleLabel(s.throwStyle)} · Yaw ${s.aimYaw.toFixed(1)}° Pitch ${s.aimPitch.toFixed(1)}°`, `Kaynak: ${s.source === "seed" ? "Hazır liste" : s.source === "library" ? "Kütüphane" : "Bu demo"} (${s.support})`], "#3ddc84");
    l3.position.copy(fp).add(new THREE.Vector3(0, 250, 0));
    grp.add(l3);
    const lp = V(s.land[0], s.land[1], s.land[2]);
    grp.add(ring(lp, 40, GREEN), beam(lp, GREEN));
    const l4 = labelSprite(["Önerilen düşüş", s.landPlace ?? "—"], "#3ddc84");
    l4.position.copy(lp).add(new THREE.Vector3(0, 210, 0));
    grp.add(l4);
    this.coachGroup = grp;
    this.scene.add(grp);
  }

  /** Aim a thin cylinder from a to b. */
  private placeTracer(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, alpha: number) {
    const d = b.clone().sub(a);
    const len = d.length();
    m.position.copy(a).addScaledVector(d, 0.5);
    m.scale.set(1, len, 1);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    (m.material as THREE.MeshBasicMaterial).opacity = alpha;
    m.visible = true;
  }

  eyeOf(ps: PState): number {
    return ps.z + (has(ps.flags, FrameFlag.Ducking) ? EYE_H_DUCK : EYE_H);
  }

  /**
   * Shows the real map geometry instead of the reconstructed floor (null = back to the stylised blockout).
   * The asset's meshes are shared between Scene3D instances (3D view + video export), so a second user gets a
   * shallow clone (same geometry/materials) and dispose() never frees them.
   */
  setRealMap(asset: RealMapAsset | null) {
    if (this.realRoot) {
      this.scene.remove(this.realRoot);
      this.realRoot = null;
    }
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
      this.sky = null;
    }
    this.realMap = asset;
    const r = this.renderer;
    const sc = this.scene;
    if (!asset) {
      this.floorGroup.visible = true;
      r.toneMapping = THREE.NoToneMapping;
      r.toneMappingExposure = 1;
      r.shadowMap.enabled = false;
      r.clippingPlanes = [];
      sc.background = new THREE.Color(0x0a1019);
      sc.fog = new THREE.FogExp2(0x0a1019, 0.00011);
      this.hemi.color.set(0xb6ccff);
      this.hemi.groundColor.set(0x1b2433);
      this.hemi.intensity = 1.15;
      this.sun.color.set(0xfff0dc);
      this.sun.intensity = 1.5;
      this.sun.castShadow = false;
      this.sun.position.set(-1200, 2400, 900);
      this.sun.target.position.set(0, 0, 0);
      this.ambient.intensity = 0.5;
      this.camera.near = 2;
      return;
    }
    this.floorGroup.visible = false;
    const root = asset.root.parent ? asset.root.clone() : asset.root;
    this.realRoot = root;
    sc.add(root);
    const ex = asset.extras;
    const b = ex.bounds;
    this.boundsCenter.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    this.boundsSize = Math.max(1000, Math.min(16000, Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2])));
    // ---- light: sun from light_environment, sky/ground fill, filmic tone mapping
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    const sun = ex.sun;
    const toSun = new THREE.Vector3(...(sun?.toSun ?? [0.35, 0.82, 0.45])).normalize();
    if (toSun.y < 0.15) toSun.y = 0.15;
    toSun.normalize();
    (this.sun.userData as any).toSun = toSun;
    const sunCol = new THREE.Color().setRGB(...((sun?.color ?? [1, 0.95, 0.86]) as [number, number, number]), THREE.SRGBColorSpace);
    this.sun.color.copy(sunCol);
    this.sun.intensity = 2.6 * Math.max(0.5, Math.min(2.2, sun?.brightness ?? 1.2));
    this.sun.castShadow = true;
    const hi = asset.stats.triangles > 1.5e6 ? 4096 : 2048;
    this.sun.shadow.mapSize.set(hi, hi);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 1.2;
    this.shadowHalf = 0;
    const skyTint = new THREE.Color().setRGB(...((ex.sky?.tint ?? [1, 1, 1]) as [number, number, number]), THREE.SRGBColorSpace);
    const zenith = new THREE.Color(0x5d8fd6).multiply(skyTint);
    const horizon = ex.fog?.color ? new THREE.Color().setRGB(...(ex.fog.color as [number, number, number]), THREE.SRGBColorSpace) : new THREE.Color(0xc9d6e3).multiply(skyTint);
    this.hemi.color.copy(zenith).lerp(new THREE.Color(0xffffff), 0.45);
    this.hemi.groundColor.set(0x6e6152);
    this.hemi.intensity = 1.25;
    this.ambient.color.set(0xffffff);
    this.ambient.intensity = sun?.ambient ? 0.35 : 0.22;
    if (sun?.ambient) this.ambient.color.setRGB(...(sun.ambient as [number, number, number]), THREE.SRGBColorSpace);
    sc.background = horizon.clone();
    // fog: from env_cubemap_fog / env_gradient_fog when present, otherwise a light aerial haze
    const fs = ex.fog?.start ?? null;
    const fe = ex.fog?.end ?? null;
    sc.fog = fs != null && fe != null && fe > fs && fe > 500 ? new THREE.Fog(horizon, fs, fe / Math.max(0.2, Math.min(1, ex.fog?.maxOpacity ?? 1))) : new THREE.Fog(horizon, 4000, 26000);
    // sky dome (vertical gradient, follows the camera)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: zenith }, bottom: { value: horizon }, sunDir: { value: toSun }, sunCol: { value: sunCol } },
      vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader:
        "uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vDir; void main(){ float h = clamp(vDir.y * 1.6 + 0.05, 0.0, 1.0); vec3 c = mix(bottom, top, pow(h, 0.7)); float s = max(dot(normalize(vDir), sunDir), 0.0); c += sunCol * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.18); gl_FragColor = vec4(c, 1.0); \n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(30000, 32, 16), skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    sc.add(this.sky);
    this.camera.near = 2;
  }

  /** Keeps the shadow frustum around what the camera looks at (texel-snapped to avoid shimmering). */
  private updateSun(mode: CamMode) {
    if (!this.realMap || !this.sun.castShadow) return;
    const toSun = (this.sun.userData as any).toSun as THREE.Vector3;
    const cam = this.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    let half: number;
    const focus = new THREE.Vector3();
    if (mode === "top") {
      half = Math.min(9000, this.boundsSize * 0.62);
      focus.copy(this.boundsCenter);
    } else {
      half = mode === "free" ? 2600 : 1700;
      focus.copy(cam.position).addScaledVector(dir.setY(0).normalize(), half * 0.55);
      focus.y = cam.position.y - 80;
    }
    const texel = (2 * half) / this.sun.shadow.mapSize.x;
    focus.x = Math.round(focus.x / texel) * texel;
    focus.z = Math.round(focus.z / texel) * texel;
    focus.y = Math.round(focus.y / texel) * texel;
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    if (half !== this.shadowHalf) {
      this.shadowHalf = half;
      sc.left = -half;
      sc.right = half;
      sc.top = half;
      sc.bottom = -half;
      sc.near = 10;
      sc.far = 12000;
      sc.updateProjectionMatrix();
    }
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(toSun, 6000);
    this.sun.target.updateMatrixWorld();
    if (this.sky) this.sky.position.copy(cam.position);
  }

  update(tick: number, spec: CamSpec, opts: { speaking: Set<number>; focus: { pos: [number, number, number]; ts: number } | null; now: number }) {
    const m = this.match;
    const tr = m.tickRate;
    const ri = m.roundIndexAt(tick);
    this.time = opts.now / 1000;
    if (ri !== this.curRound) {
      this.clearRoundObjects();
      this.curRound = ri;
    }
    // ---- players
    const dt = this.lastNow ? Math.min(0.1, Math.max(0, (opts.now - this.lastNow) / 1000)) : 0;
    this.lastNow = opts.now;
    const muzzles: (THREE.Vector3 | null)[] = [];
    for (let s = 0; s < m.pc; s++) {
      const pv = this.players[s];
      const ps = m.sample(tick, s, this.tmp[s]);
      const present = has(ps.flags, FrameFlag.Connected) || ps.flags !== 0;
      const alive = isAlive(ps);
      const side = has(ps.flags, FrameFlag.SideCT) ? "CT" : "T";
      const col = new THREE.Color(SIDE_COLOR[side]);
      const isPovSelf = spec.mode === "pov" && s === spec.selected && alive;
      pv.group.visible = present && !isPovSelf;
      muzzles[s] = null;
      if (this.actors) {
        pv.group.visible = false;
        const k0 = !alive ? m.killsByRound[Math.max(0, ri)]?.find((q) => q.victim === s && q.tick <= tick) : undefined;
        const prev = m.sample(tick - 8, s, this.tmp[15]);
        const vdt = 8 / tr;
        for (const sd of ["CT", "T"] as const) {
          const ch = this.character(s, sd);
          if (!ch) continue;
          const mine = sd === side;
          const pos = k0 ? k0.victimPos : [ps.x, ps.y, ps.z];
          ch.update(
            {
              x: pos[0], y: pos[1], z: pos[2], yaw: ps.yaw, pitch: ps.pitch,
              vx: alive ? (ps.x - prev.x) / vdt : 0, vy: alive ? (ps.y - prev.y) / vdt : 0,
              duck: has(ps.flags, FrameFlag.Ducking), walking: has(ps.flags, FrameFlag.Walking), alive,
              deadFor: k0 ? (tick - k0.tick) / tr : 99, weapon: m.weaponName(ps.weapon), defuser: has(ps.flags, FrameFlag.HasDefuser),
              visible: mine && present && !isPovSelf && (alive || !!k0),
            },
            dt,
            this.time,
          );
          if (mine && alive) muzzles[s] = ch.muzzle;
        }
      }
      pv.bodyMat.color.copy(col);
      if (!alive) {
        pv.bodyMat.color.multiplyScalar(0.35);
        pv.bodyMat.emissive.setRGB(0, 0, 0);
        pv.group.rotation.set(0, ps.yaw * DEG, Math.PI / 2 - 0.05);
        pv.group.position.set(ps.x, ps.z + 8, -ps.y);
        // use kill pos for stability
      } else {
        pv.bodyMat.emissive.copy(col).multiplyScalar(s === spec.selected ? 0.35 : 0.1);
        pv.group.rotation.set(0, ps.yaw * DEG, 0);
        pv.group.position.set(ps.x, ps.z, -ps.y);
      }
      const duck = has(ps.flags, FrameFlag.Ducking);
      // model top: 78 standing -> 72 units after scaling; crouched 54 units
      pv.group.scale.setScalar(PLAYER_H / MODEL_TOP);
      const drop = duck ? MODEL_TOP - (PLAYER_H_DUCK * MODEL_TOP) / PLAYER_H : 0;
      pv.legs.scale.y = duck ? (32 - drop) / 32 : 1;
      pv.upper.position.y = -drop;
      pv.gun.rotation.z = -(ps.pitch * DEG) * 0.9;
      pv.pack.visible = has(ps.flags, FrameFlag.HasBomb) && alive;
      pv.gun.visible = alive;
      // tag
      const tp = pv.tag.position;
      Scene3D.v(ps.x, ps.y, ps.z + (duck ? PLAYER_H_DUCK : PLAYER_H) + 30, tp);
      const camDist = this.camera.position.distanceTo(tp);
      const tk = Math.min(2.4, Math.max(0.45, camDist / 650));
      pv.tag.scale.set(70 * tk, 17.5 * tk, 1);
      // far away (top / free views): flat team-coloured marker so players stay readable
      const far = camDist > 1100 && alive && present;
      pv.disc.visible = far;
      if (far) {
        pv.disc.position.set(ps.x, ps.z + 6, -ps.y);
        const r = Math.max(24, camDist * 0.012);
        pv.disc.scale.set(r, r, 1);
        (pv.disc.material as THREE.MeshBasicMaterial).color.copy(col);
      }
      pv.tag.visible = present && alive && !isPovSelf && !(spec.mode === "chase" && s === spec.selected);
      if (pv.tag.visible) this.drawTag(pv, m.players[s].name, ps.health, side, s === spec.selected, opts.speaking.has(s));
      // cross
      const k = !alive ? m.killsByRound[Math.max(0, ri)]?.find((q) => q.victim === s && q.tick <= tick) : undefined;
      pv.cross.visible = present && !alive && !!k && !this.actors;
      if (k) {
        Scene3D.v(k.victimPos[0], k.victimPos[1], k.victimPos[2] + 2, pv.cross.position);
        pv.group.position.set(k.victimPos[0], k.victimPos[2] + 8, -k.victimPos[1]);
        (pv.cross.children[0] as THREE.Mesh).material = (pv.cross.children[0] as THREE.Mesh).material;
      }
    }

    // ---- grenades
    const gl = ri >= 0 ? m.grenadesByRound[ri] : [];
    for (const g of gl) {
      const end = grenadeEnd(g, tr);
      const active = tick >= g.throwTick && tick <= end + 0.6 * tr;
      let gv = this.grens.get(g.id);
      if (!active) {
        if (gv) {
          gv.ball.visible = false;
          gv.trail.visible = false;
          if (gv.fx) gv.fx.visible = false;
        }
        continue;
      }
      if (!gv) {
        gv = this.makeGrenVis(g);
        this.grens.set(g.id, gv);
      }
      const t = g.trajectory;
      const n = t.length / 4;
      const inFlight = g.detonateTick == null ? tick <= t[(n - 1) * 4] : tick < g.detonateTick;
      gv.ball.visible = false;
      gv.trail.visible = false;
      if (n >= 2 && inFlight) {
        let cnt = 0;
        while (cnt < n && t[cnt * 4] <= tick) cnt++;
        gv.trail.geometry.setDrawRange(0, Math.max(0, cnt));
        gv.trail.visible = cnt > 1;
        const p = this.gpos(g, tick);
        if (p) {
          gv.ball.position.set(p[0], p[2], -p[1]);
          gv.ball.visible = true;
        }
      } else if (n >= 2) {
        gv.trail.geometry.setDrawRange(0, n);
        gv.trail.visible = tick - (g.detonateTick ?? tick) < 1.0 * tr;
        (gv.trail.material as THREE.LineBasicMaterial).opacity = Math.max(0, 0.75 - ((tick - (g.detonateTick ?? tick)) / tr) * 0.75);
      }
      if (gv.fx && g.detonateTick != null && tick >= g.detonateTick) {
        const dt = (tick - g.detonateTick) / tr;
        const total = Math.max(0.01, (end - g.detonateTick) / tr);
        gv.fx.visible = true;
        if (g.type === "smoke") {
          const grow = Math.min(1, dt / 0.8);
          const fade = Math.max(0, Math.min(1, (total - dt) / 2));
          gv.sprites.forEach((sp, i) => {
            const a = this.rnd(g.id, i) * Math.PI * 2;
            const rr = Math.sqrt(this.rnd(g.id, i + 40)) * 105 * (0.35 + 0.65 * grow);
            const sw = Math.sin(this.time * 0.35 + i) * 6;
            sp.position.set(Math.cos(a) * rr + sw, 10 + this.rnd(g.id, i + 80) * 110 * grow, Math.sin(a) * rr);
            const sc = (95 + this.rnd(g.id, i + 120) * 60) * (0.5 + 0.5 * grow);
            sp.scale.set(sc, sc, 1);
            sp.material.opacity = 0.62 * fade;
            sp.material.rotation = this.time * 0.05 * (i % 2 ? 1 : -1) + i;
          });
        } else if (g.type === "molotov") {
          const fade = Math.max(0, Math.min(1, (total - dt) / 1));
          gv.sprites.forEach((sp, i) => {
            const a = this.rnd(g.id, i) * Math.PI * 2;
            const rr = Math.sqrt(this.rnd(g.id, i + 40)) * 95;
            const ph = (this.time * 1.4 + this.rnd(g.id, i + 7) * 6) % 1;
            sp.position.set(Math.cos(a) * rr, 8 + ph * 46, Math.sin(a) * rr);
            const sc = (55 + this.rnd(g.id, i + 90) * 40) * (1 - ph * 0.5);
            sp.scale.set(sc, sc * 1.35, 1);
            sp.material.opacity = (0.85 - ph * 0.5) * fade;
          });
        } else if (g.type === "flash") {
          const k = dt / 0.45;
          gv.fx.visible = k < 1;
          const sp = gv.sprites[0];
          if (sp) {
            sp.scale.set(60 + k * 520, 60 + k * 520, 1);
            sp.position.y = 40;
            sp.material.opacity = Math.max(0, 1 - k);
          }
        } else if (g.type === "he") {
          const k = dt / 0.55;
          gv.fx.visible = k < 1;
          const sp = gv.sprites[0];
          if (sp) {
            sp.scale.set(40 + k * 380, 40 + k * 380, 1);
            sp.position.y = 30;
            sp.material.opacity = Math.max(0, 1 - k);
          }
        } else gv.fx.visible = false;
      } else if (gv.fx) gv.fx.visible = false;
    }

    // ---- tracers
    let ti = 0;
    let fi = 0;
    const tmpA = new THREE.Vector3(),
      tmpB = new THREE.Vector3(),
      tmpD = new THREE.Vector3();
    const win = 0.14 * tr;
    for (const sh of m.demo.shots ?? []) {
      if (sh.tick > tick || tick - sh.tick > win) continue;
      if (ti >= this.tracers.length) break;
      const ps = m.sample(sh.tick, sh.player, this.tmp[12]);
      if (!isAlive(ps)) continue;
      const yaw = ps.yaw * DEG,
        pit = -ps.pitch * DEG;
      tmpD.set(Math.cos(yaw) * Math.cos(pit), Math.sin(pit), -Math.sin(yaw) * Math.cos(pit));
      const mz = muzzles[sh.player];
      if (mz && !(spec.mode === "pov" && sh.player === spec.selected)) {
        tmpA.copy(mz);
        const age = (tick - sh.tick) / tr;
        if (age < 0.06 && fi < this.flashes.length) {
          const f = this.flashes[fi++];
          f.visible = true;
          f.position.copy(mz);
          const sz = 26 + this.rnd(sh.tick, 3) * 18;
          f.scale.set(sz, sz, 1);
          f.material.opacity = 1 - age / 0.06;
        }
      } else {
        Scene3D.v(ps.x, ps.y, this.eyeOf(ps) - 6, tmpA);
        tmpA.addScaledVector(tmpD, 30);
      }
      tmpB.copy(tmpA).addScaledVector(tmpD, 900);
      this.placeTracer(this.tracers[ti++], tmpA, tmpB, 0.85 * (1 - (tick - sh.tick) / win));
    }
    for (; ti < this.tracers.length; ti++) this.tracers[ti].visible = false;
    for (; fi < this.flashes.length; fi++) this.flashes[fi].visible = false;

    // ---- bomb
    const bs = m.bombState(tick);
    this.bomb.visible = false;
    this.bombDropped.visible = false;
    if (bs.pos && bs.kind === "planted") {
      this.bomb.visible = true;
      Scene3D.v(bs.pos[0], bs.pos[1], bs.pos[2], this.bomb.position);
      const left = 40 - (tick - bs.plantedTick) / tr;
      this.bombLed.visible = Math.sin(this.time * (left < 10 ? 18 : 6)) > -0.2;
    } else if (bs.pos && bs.kind === "dropped") {
      this.bombDropped.visible = true;
      Scene3D.v(bs.pos[0], bs.pos[1] + 0, bs.pos[2] + 5, this.bombDropped.position);
    }

    // ---- focus marker
    if (opts.focus && opts.now - opts.focus.ts < 4000) {
      const k = ((opts.now - opts.focus.ts) % 1200) / 1200;
      this.focusMarker.visible = true;
      Scene3D.v(opts.focus.pos[0], opts.focus.pos[1], opts.focus.pos[2] + 4, this.focusMarker.position);
      this.focusMarker.scale.setScalar(0.5 + k * 1.6);
      (this.focusMarker.material as THREE.MeshBasicMaterial).opacity = 1 - k;
    } else this.focusMarker.visible = false;

    // ---- camera
    this.placeCamera(tick, spec);
    this.updateSun(spec.mode);
    // top view of the real map: cut away roofs above the watched player so the playable floor is visible
    if (this.realMap && spec.mode === "top") {
      const ps = m.sample(tick, spec.selected, this.tmp[14]);
      const cut = (isAlive(ps) ? ps.z : this.boundsCenter.y) + 190;
      this.clipPlane.constant = cut;
      this.renderer.clippingPlanes = [this.clipPlane];
    } else if (this.renderer.clippingPlanes.length) this.renderer.clippingPlanes = [];
    this.renderer.render(this.scene, this.camera);
    if (this.vmOn && this.vm) {
      // first-person arms and weapon over the world, with their own depth
      const ac = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      const cp = this.renderer.clippingPlanes;
      this.renderer.clippingPlanes = [];
      this.renderer.render(this.vm.scene, this.vm.camera);
      this.renderer.clippingPlanes = cp;
      this.renderer.autoClear = ac;
    }
  }

  private gpos(g: Grenade, tick: number): [number, number, number] | null {
    const t = g.trajectory;
    const n = t.length / 4;
    if (n < 1 || tick < t[0]) return null;
    let i = 0;
    while (i < n - 1 && t[(i + 1) * 4] <= tick) i++;
    if (i >= n - 1) return [t[(n - 1) * 4 + 1], t[(n - 1) * 4 + 2], t[(n - 1) * 4 + 3]];
    const f = (tick - t[i * 4]) / Math.max(1, t[(i + 1) * 4] - t[i * 4]);
    return [0, 1, 2].map((k) => t[i * 4 + 1 + k] + (t[(i + 1) * 4 + 1 + k] - t[i * 4 + 1 + k]) * f) as [number, number, number];
  }

  private placeCamera(tick: number, spec: CamSpec) {
    const cam = this.camera;
    const m = this.match;
    const aspect = spec.w / Math.max(1, spec.h);
    const vfov = (hf: number) => (2 * Math.atan(Math.tan((hf * DEG) / 2) / aspect)) / DEG;
    cam.aspect = aspect;
    this.view.visible = false;
    this.vmOn = false;
    cam.up.set(0, 1, 0);
    let mode = spec.mode;
    if (mode === "pov" && !isAlive(m.sample(tick, spec.selected, this.tmp[13]))) mode = "chase"; // dead: look at the body from behind
    if (mode === "pov") {
      const ps = m.sample(tick, spec.selected, this.tmp[13]);
      const yaw = ps.yaw * DEG,
        pit = -ps.pitch * DEG;
      cam.position.set(ps.x, this.eyeOf(ps), -ps.y);
      const scoped = has(ps.flags, FrameFlag.Scoped);
      cam.fov = Math.min(110, vfov(scoped ? 35 : 90));
      cam.lookAt(cam.position.x + Math.cos(yaw) * Math.cos(pit), cam.position.y + Math.sin(pit), cam.position.z - Math.sin(yaw) * Math.cos(pit));
      this.view.visible = isAlive(ps) && !scoped;
      const wn = m.weaponName(ps.weapon);
      if (this.vm && isAlive(ps) && !scoped) {
        const prev = m.sample(tick - 8, spec.selected, this.tmp[15]);
        let shotAge: number | null = null;
        for (const sh of m.demo.shots ?? []) if (sh.player === spec.selected && sh.tick <= tick && tick - sh.tick < m.tickRate) shotAge = (tick - sh.tick) / m.tickRate;
        this.vmOn = this.vm.update({
          side: has(ps.flags, FrameFlag.SideCT) ? "CT" : "T",
          weapon: wn,
          shotAge,
          speed: Math.hypot(ps.x - prev.x, ps.y - prev.y) / (8 / m.tickRate),
          time: this.time,
          aspect,
          sunColor: this.sun.color,
        });
        this.view.visible = false; // the game's viewmodel replaces the stand-in (nothing while its clips load)
      }
      this.viewGun.scale.set(1, 1, /knife|grenade|flash|smoke|molotov|decoy|c4/.test(wn) ? 0.4 : 1);
    } else if (mode === "chase") {
      const ps = m.sample(tick, spec.selected, this.tmp[13]);
      const yaw = ps.yaw * DEG;
      const back = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
      const head = new THREE.Vector3(ps.x, ps.z + 70, -ps.y);
      cam.position.copy(head).addScaledVector(back, 170).add(new THREE.Vector3(0, 95, 0));
      cam.fov = vfov(80);
      cam.lookAt(head.x, head.y - 5, head.z);
    } else if (mode === "free") {
      const f = spec.free;
      const yaw = f.yaw * DEG,
        pit = -f.pitch * DEG;
      cam.position.set(f.x, f.z, -f.y);
      cam.fov = vfov(90);
      cam.lookAt(f.x + Math.cos(yaw) * Math.cos(pit), f.z + Math.sin(pit), -f.y - Math.sin(yaw) * Math.cos(pit));
    } else {
      const t = spec.top;
      cam.position.set(t.cx, t.h, -t.cy);
      cam.up.set(0, 0, -1);
      cam.fov = 40;
      cam.lookAt(t.cx, 0, -t.cy);
    }
    cam.updateProjectionMatrix();
  }

  dispose() {
    // the real map's meshes are shared and cached: never free them here
    this.setRealMap(null);
    this.setActors(null);
    this.clearRoundObjects();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.smokeTex.dispose();
    this.fireTex.dispose();
    this.glowTex.dispose();
  }

  /** Default free camera: above the map looking at the centre. */
  defaultFree(): FreeCam {
    const f = this.match.floor;
    return { x: this.boundsCenter.x - f.w * f.cell * 0.0, y: -this.boundsCenter.z - this.boundsSize * 0.55, z: f.zMax + this.boundsSize * 0.35, yaw: 90, pitch: 38 };
  }
  defaultTop(): TopCam {
    return { cx: this.boundsCenter.x, cy: -this.boundsCenter.z, h: this.boundsSize * 1.05 };
  }
}
