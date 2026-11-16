import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { getActorAsset } from "../lib/backend";
import { compressedTexturesOk } from "./realmap";

/**
 * The game's own player agents, weapons and animation clips (read from the user's CS2 install by the backend), so the 3D
 * view looks like watching inside the game. Models arrive as skinned glTF in Source space (inches, Z up, bones named as
 * in the game); clips as the KV3 data of CS2's animation resources (`.vnmclip`, Esoterica's compressed clip format),
 * decoded here.
 */

const SKELETON = "animation/skeletons/characters/worldmodel.vnmskel";
export const AGENT_MODEL = { CT: "agents/models/ctm_sas/ctm_sas.vmdl", T: "agents/models/tm_phoenix/tm_phoenix.vmdl" } as const;

/** Demo weapon name (rewind-core's normalized name) -> world model. */
const WEAPON_MODELS: Record<string, string> = {
  ak47: "ak47/weapon_rif_ak47", aug: "aug/weapon_rif_aug", awp: "awp/weapon_snip_awp", bizon: "bizon/weapon_smg_bizon", c4: "c4/weapon_c4",
  cz75a: "cz75a/weapon_pist_cz75a", deagle: "deagle/weapon_pist_deagle", elite: "elite/weapon_pist_elite", famas: "famas/weapon_rif_famas",
  fiveseven: "fiveseven/weapon_pist_fiveseven", g3sg1: "g3sg1/weapon_snip_g3sg1", galilar: "galilar/weapon_rif_galilar", glock: "glock18/weapon_pist_glock18",
  decoy: "grenade/decoy/weapon_decoy", flashbang: "grenade/flashbang/weapon_flashbang", hegrenade: "grenade/hegrenade/weapon_hegrenade",
  incgrenade: "grenade/incendiary/weapon_incendiarygrenade", molotov: "grenade/molotov/weapon_molotov", smokegrenade: "grenade/smokegrenade/weapon_smokegrenade",
  hkp2000: "hkp2000/weapon_pist_hkp2000", m249: "m249/weapon_mach_m249", m4a1_silencer: "m4a1_silencer/weapon_rif_m4a1_silencer", m4a1: "m4a4/weapon_rif_m4a4",
  mac10: "mac10/weapon_smg_mac10", mag7: "mag7/weapon_shot_mag7", mp5sd: "mp5sd/weapon_smg_mp5sd", mp7: "mp7/weapon_smg_mp7", mp9: "mp9/weapon_smg_mp9",
  negev: "negev/weapon_mach_negev", nova: "nova/weapon_shot_nova", p250: "p250/weapon_pist_p250", p90: "p90/weapon_smg_p90", revolver: "revolver/weapon_pist_revolver",
  sawedoff: "sawedoff/weapon_shot_sawedoff", scar20: "scar20/weapon_snip_scar20", sg556: "sg556/weapon_rif_sg556", ssg08: "ssg08/weapon_snip_ssg08",
  taser: "taser/weapon_pist_taser", tec9: "tec9/weapon_pist_tec9", ump45: "ump45/weapon_smg_ump45", usp_silencer: "usp_silencer/weapon_pist_usp_silencer",
  xm1014: "xm1014/weapon_shot_xm1014",
};
export function weaponModelPath(w: string, side: "CT" | "T"): string | null {
  if (w === "knife") return `weapons/models/knife/knife_default_${side === "CT" ? "ct" : "t"}/weapon_knife_default_${side === "CT" ? "ct" : "t"}.vmdl`;
  const p = WEAPON_MODELS[w];
  return p ? `weapons/models/${p}.vmdl` : null;
}

export type WClass = "rifle" | "pistol" | "knife" | "grenade";
const PISTOLS = new Set(["glock", "usp_silencer", "hkp2000", "p250", "fiveseven", "tec9", "cz75a", "deagle", "revolver", "elite", "taser"]);
export function weaponClass(w: string): WClass {
  if (!w || w === "knife") return "knife";
  if (PISTOLS.has(w)) return "pistol";
  if (/grenade|flashbang|molotov|decoy|c4/.test(w)) return "grenade";
  return "rifle";
}

/** Weapon -> its first-person (viewmodel) idle and shoot clips; missing ones fall back to the class default. */
function viewClips(w: string, side: "CT" | "T"): { idle: string; shoot: string | null; fallback: { idle: string; shoot: string | null } } {
  const V = "animation/anims/viewmodel";
  const cls = weaponClass(w);
  const def = {
    rifle: { idle: `${V}/rifle/_default_rifle/idle_rifle.vnmclip`, shoot: `${V}/rifle/_default_rifle/shoot1_rifle.vnmclip` },
    pistol: { idle: `${V}/pistol/_default_pistol/idle_pistol.vnmclip`, shoot: `${V}/pistol/_default_pistol/shoot1_pistol.vnmclip` },
    knife: { idle: `${V}/knife/_default_knife/idle_knife.vnmclip`, shoot: null },
    grenade: { idle: `${V}/grenade/_default_grenade/idle_grenade.vnmclip`, shoot: null },
  }[cls];
  const rifle: Record<string, [string, string, string?]> = {
    ak47: ["rifle_ak", "ak"], m4a1: ["rifle_m4a4", "m4a4"], g3sg1: ["rifle_g3sg1", "g3sg1", "idle1"], m249: ["rifle_m249", "m249", "idle1"],
  };
  for (const k of ["aug", "awp", "bizon", "famas", "galilar", "mac10", "mag7", "mp5sd", "mp7", "mp9", "negev", "nova", "p90", "sawedoff", "scar20", "sg556", "ssg08", "ump45", "xm1014"]) rifle[k] = [`rifle_${k}`, k];
  const pistol: Record<string, [string, string]> = { glock: ["pistol_glock18", "glock"], hkp2000: ["pistol_hkp2000", "hkp"], elite: ["pistol_elite", "elite"] };
  for (const k of ["p250", "fiveseven", "tec9", "cz75a", "deagle", "revolver", "taser"]) pistol[k] = [`pistol_${k}`, k];
  const nade: Record<string, [string, string]> = { flashbang: ["grenade_flashbang", "flashbang"], hegrenade: ["grenade_hegrenade", "hegrenade"], incgrenade: ["grenade_incendiary", "incendiary"], molotov: ["grenade_molotov", "molotov"], smokegrenade: ["grenade_smokegrenade", "smoke"] };
  if (rifle[w]) {
    const [d, sfx, idle] = rifle[w];
    return { idle: `${V}/rifle/${d}/${idle ?? "idle"}_${sfx}.vnmclip`, shoot: `${V}/rifle/${d}/shoot1_${sfx}.vnmclip`, fallback: def };
  }
  if (pistol[w]) {
    const [d, sfx] = pistol[w];
    return { idle: `${V}/pistol/${d}/idle_${sfx}.vnmclip`, shoot: w === "elite" ? def.shoot : `${V}/pistol/${d}/shoot1_${sfx}.vnmclip`, fallback: def };
  }
  if (nade[w]) return { idle: `${V}/grenade/${nade[w][0]}/idle_${nade[w][1]}.vnmclip`, shoot: null, fallback: def };
  if (w === "c4") return { idle: `${V}/equipment/c4/idle_c4.vnmclip`, shoot: null, fallback: def };
  if (w === "knife" && side === "T") return { idle: `${V}/knife/knife_default_t/idle_default_t.vnmclip`, shoot: null, fallback: def };
  return { ...def, fallback: def };
}

const DIRS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
type Gait = "run" | "walk" | "crouch";
interface ClipSet {
  idle: NmClip;
  idleCrouch: NmClip;
  move: Record<Gait, NmClip[]>; // by DIRS index
}

// ---------------------------------------------------------------- skeleton and clips

export class NmSkeleton {
  names: string[];
  parents: Int16Array;
  refT: Float32Array;
  refQ: Float32Array;
  index = new Map<string, number>();
  constructor(kv: any) {
    this.names = kv.m_boneIDs as string[];
    this.parents = Int16Array.from(kv.m_parentIndices as number[]);
    const n = this.names.length;
    this.refT = new Float32Array(n * 3);
    this.refQ = new Float32Array(n * 4);
    (kv.m_parentSpaceReferencePose as number[][]).forEach((r, i) => {
      this.refT.set([r[0], r[1], r[2]], i * 3);
      this.refQ.set([r[4], r[5], r[6], r[7]], i * 4);
    });
    this.names.forEach((b, i) => this.index.set(b, i));
  }
}

/** Local (parent-space) pose of the skeleton's bones, Source units. */
export class Pose {
  t: Float32Array;
  q: Float32Array;
  constructor(n: number) {
    this.t = new Float32Array(n * 3);
    this.q = new Float32Array(n * 4);
  }
}

const QMIN = -Math.SQRT1_2;
const QK = (2 * Math.SQRT1_2) / 0x7fff;

/** Esoterica's 48-bit quaternion: 2 bits for the largest component's index, three 15-bit components. */
export function decodeQuat(a: number, b: number, c: number, out: Float32Array, o: number) {
  const x = (a & 0x7fff) * QK + QMIN;
  const y = (b & 0x7fff) * QK + QMIN;
  const z = (c & 0x7fff) * QK + QMIN;
  const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  switch (((a >> 14) & 2) | (b >> 15)) {
    case 0: out[o] = w; out[o + 1] = x; out[o + 2] = y; out[o + 3] = z; break;
    case 1: out[o] = x; out[o + 1] = w; out[o + 2] = y; out[o + 3] = z; break;
    case 2: out[o] = x; out[o + 1] = y; out[o + 2] = w; out[o + 3] = z; break;
    default: out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
  }
}

/** A decoded `.vnmclip`: every frame's local pose of the skeleton's bones. */
export class NmClip {
  frames: number;
  duration: number;
  /** Average root speed (units/s) from the clip's root motion, 0 for in-place clips. */
  speed: number;
  t: Float32Array;
  q: Float32Array;
  nb: number;
  constructor(kv: any, skel: NmSkeleton) {
    const nb = skel.names.length;
    this.nb = nb;
    this.frames = Math.max(1, kv.m_nNumFrames | 0);
    this.duration = Math.max(1e-3, kv.m_flDuration || 0);
    this.speed = Math.abs(kv.m_rootMotion?.m_flAverageLinearVelocity ?? 0);
    const tracks = kv.m_trackCompressionSettings as any[];
    const data = kv.m_compressedPoseData as number[];
    const offs = kv.m_compressedPoseOffsets as number[];
    this.t = new Float32Array(this.frames * nb * 3);
    this.q = new Float32Array(this.frames * nb * 4);
    for (let f = 0; f < this.frames; f++) {
      const base = offs[Math.min(f, offs.length - 1)] ?? 0;
      for (let i = 0; i < nb; i++) {
        const to = (f * nb + i) * 3;
        const qo = (f * nb + i) * 4;
        const s = tracks[i];
        if (!s) {
          this.t.set(skel.refT.subarray(i * 3, i * 3 + 3), to);
          this.q.set(skel.refQ.subarray(i * 4, i * 4 + 4), qo);
          continue;
        }
        let p = base + (s.m_nTrackReadOffset | 0);
        if (s.m_bIsRotationStatic) this.q.set(s.m_constantRotation, qo);
        else {
          decodeQuat(data[p], data[p + 1], data[p + 2], this.q, qo);
          p += 3;
        }
        const rx = s.m_translationRangeX, ry = s.m_translationRangeY, rz = s.m_translationRangeZ;
        if (s.m_bIsTranslationStatic) {
          this.t[to] = rx.m_flRangeStart;
          this.t[to + 1] = ry.m_flRangeStart;
          this.t[to + 2] = rz.m_flRangeStart;
        } else {
          this.t[to] = (data[p] / 65535) * rx.m_flRangeLength + rx.m_flRangeStart;
          this.t[to + 1] = (data[p + 1] / 65535) * ry.m_flRangeLength + ry.m_flRangeStart;
          this.t[to + 2] = (data[p + 2] / 65535) * rz.m_flRangeLength + rz.m_flRangeStart;
        }
      }
    }
  }

  /** Pose at normalized time `u` (0..1, wrapped when `loop`), blended into `out` with weight `w` (first write: w = 1, add = false). */
  sample(u: number, out: Pose, w: number, add: boolean, loop = true) {
    const nb = this.nb;
    let ff = (loop ? u - Math.floor(u) : Math.min(1, Math.max(0, u))) * (this.frames - 1);
    if (this.frames < 2) ff = 0;
    const f0 = Math.floor(ff);
    const f1 = Math.min(this.frames - 1, f0 + 1);
    const a = ff - f0;
    for (let i = 0; i < nb; i++) {
      const t0 = (f0 * nb + i) * 3, t1 = (f1 * nb + i) * 3;
      const q0 = (f0 * nb + i) * 4, q1 = (f1 * nb + i) * 4;
      for (let k = 0; k < 3; k++) {
        const v = this.t[t0 + k] + (this.t[t1 + k] - this.t[t0 + k]) * a;
        out.t[i * 3 + k] = add ? out.t[i * 3 + k] + v * w : v * w;
      }
      // nlerp between frames, then a weighted sum on the same hemisphere (normalized at the end)
      let qx = this.q[q0], qy = this.q[q0 + 1], qz = this.q[q0 + 2], qw = this.q[q0 + 3];
      let bx = this.q[q1], by = this.q[q1 + 1], bz = this.q[q1 + 2], bw = this.q[q1 + 3];
      if (qx * bx + qy * by + qz * bz + qw * bw < 0) (bx = -bx), (by = -by), (bz = -bz), (bw = -bw);
      qx += (bx - qx) * a; qy += (by - qy) * a; qz += (bz - qz) * a; qw += (bw - qw) * a;
      const o = i * 4;
      if (add) {
        const s = out.q[o] * qx + out.q[o + 1] * qy + out.q[o + 2] * qz + out.q[o + 3] * qw < 0 ? -w : w;
        out.q[o] += qx * s; out.q[o + 1] += qy * s; out.q[o + 2] += qz * s; out.q[o + 3] += qw * s;
      } else {
        out.q[o] = qx * w; out.q[o + 1] = qy * w; out.q[o + 2] = qz * w; out.q[o + 3] = qw * w;
      }
    }
  }
}

function normalizePose(p: Pose) {
  for (let o = 0; o < p.q.length; o += 4) {
    const l = Math.hypot(p.q[o], p.q[o + 1], p.q[o + 2], p.q[o + 3]) || 1;
    p.q[o] /= l; p.q[o + 1] /= l; p.q[o + 2] /= l; p.q[o + 3] /= l;
  }
}

// ---------------------------------------------------------------- library

let ktx2: KTX2Loader | null = null;
const textCache = new Map<string, Promise<any>>();
const glbCache = new Map<string, Promise<THREE.Group>>();

function json(path: string): Promise<any> {
  let p = textCache.get(path);
  if (!p) {
    p = getActorAsset(path, "image").then((b) => JSON.parse(new TextDecoder().decode(b)));
    textCache.set(path, p);
    p.catch(() => textCache.delete(path));
  }
  return p;
}

function model(renderer: THREE.WebGLRenderer, path: string): Promise<THREE.Group> {
  const tex = compressedTexturesOk(renderer) ? "ktx2" : "image";
  const key = path + "|" + tex;
  let p = glbCache.get(key);
  if (!p) {
    p = (async () => {
      const buf = await getActorAsset(path, tex);
      if (!ktx2) {
        ktx2 = new KTX2Loader();
        ktx2.detectSupport(renderer);
      }
      const loader = new GLTFLoader();
      loader.setKTX2Loader(ktx2);
      const g = await loader.parseAsync(buf, "");
      const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false; // skinned bounds are the bind pose's
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.envMapIntensity = 0;
        if (mat.map) {
          mat.map.anisotropy = aniso;
          if ((mat.map as THREE.CompressedTexture).isCompressedTexture) mat.map.generateMipmaps = false;
        }
      });
      return g.scene;
    })();
    glbCache.set(key, p);
    p.catch(() => glbCache.delete(key));
  }
  return p;
}

async function clipSet(skel: NmSkeleton, cls: WClass): Promise<ClipSet> {
  // grenades have no locomotion of their own: pistol legs, grenade idle
  const loco = cls === "grenade" ? "pistol" : cls;
  const dir = `animation/anims/world/${loco}/_default_${loco}`;
  const clip = async (p: string) => new NmClip(await json(p), skel);
  const g = `animation/anims/world/grenade/_default_grenade`;
  const [idle, idleCrouch] = await Promise.all([
    clip(cls === "grenade" ? `${g}/idle_grenade.vnmclip` : `${dir}/idle_${loco}.vnmclip`),
    clip(cls === "grenade" ? `${g}/idle_crouch_grenade.vnmclip` : `${dir}/idle_crouch_${loco}.vnmclip`),
  ]);
  const gaits: Gait[] = ["run", "walk", "crouch"];
  const move = {} as Record<Gait, NmClip[]>;
  await Promise.all(gaits.map(async (gt) => (move[gt] = await Promise.all(DIRS.map((d) => clip(`${dir}/${gt}_${d}_${loco}.vnmclip`))))));
  return { idle, idleCrouch, move };
}

let currentLib: ActorLibrary | null = null;
/** The library the 3D view currently uses (for the video exporter's own scene). */
export function currentActors(): ActorLibrary | null {
  return currentLib;
}
export function setCurrentActors(l: ActorLibrary | null) {
  currentLib = l;
}

/** Everything the characters need, loaded once per map view. */
export class ActorLibrary {
  skel: NmSkeleton;
  agents: Record<"CT" | "T", THREE.Group>;
  sets = new Map<WClass, ClipSet>();
  death: NmClip | null = null;
  weapons = new Map<string, THREE.Group>();
  /** CS2's first-person skeleton (null: no viewmodel). */
  vmSkel: NmSkeleton | null = null;
  private vmClips = new Map<string, { idle: NmClip; shoot: NmClip | null } | null>();
  private vmLoading = new Set<string>();
  private renderer: THREE.WebGLRenderer;

  private constructor(renderer: THREE.WebGLRenderer, skel: NmSkeleton, agents: Record<"CT" | "T", THREE.Group>) {
    this.renderer = renderer;
    this.skel = skel;
    this.agents = agents;
  }

  /** Loads the skeleton, both agents and the clip sets; weapons load in the background (`weaponNames`). Rejects when the install has none of it. */
  static async load(renderer: THREE.WebGLRenderer, weaponNames: string[]): Promise<ActorLibrary> {
    const skel = new NmSkeleton(await json(SKELETON));
    const [ct, t] = await Promise.all([model(renderer, AGENT_MODEL.CT), model(renderer, AGENT_MODEL.T)]);
    const lib = new ActorLibrary(renderer, skel, { CT: ct, T: t });
    const classes = new Set<WClass>(["rifle", "pistol", "knife"]);
    for (const w of weaponNames) classes.add(weaponClass(w));
    await Promise.all([...classes].map(async (c) => lib.sets.set(c, await clipSet(skel, c))));
    lib.vmSkel = await json("animation/skeletons/characters/viewmodel.vnmskel").then((k) => new NmSkeleton(k)).catch(() => null);
    lib.death = await json("animation/anims/world/shared/death_chest_a.vnmclip").then((k) => new NmClip(k, skel)).catch(() => null);
    for (const side of ["CT", "T"] as const)
      for (const w of new Set([...weaponNames, "knife"])) {
        const p = weaponModelPath(w, side);
        if (!p) continue;
        model(renderer, p).then((g) => lib.weapons.set(`${side}|${w}`, g)).catch(() => {});
      }
    return lib;
  }

  /** The first-person clips of a weapon (null while loading or when unavailable). */
  viewClipsFor(w: string, side: "CT" | "T"): { idle: NmClip; shoot: NmClip | null } | null {
    const k = `${side}|${w}`;
    if (this.vmClips.has(k)) return this.vmClips.get(k)!;
    const sk = this.vmSkel;
    if (!sk || this.vmLoading.has(k)) return null;
    this.vmLoading.add(k);
    const c = viewClips(w, side);
    const get = async (p: string | null, fb: string | null) => {
      if (!p) return null;
      try {
        return new NmClip(await json(p), sk);
      } catch {
        return fb && fb !== p ? new NmClip(await json(fb), sk) : null;
      }
    };
    Promise.all([get(c.idle, c.fallback.idle), get(c.shoot, c.fallback.shoot).catch(() => null)])
      .then(([idle, shoot]) => this.vmClips.set(k, idle ? { idle, shoot } : null))
      .catch(() => this.vmClips.set(k, null))
      .finally(() => this.vmLoading.delete(k));
    return null;
  }

  makeCharacter(side: "CT" | "T"): Character {
    return new Character(this, side);
  }

  weapon(side: "CT" | "T", w: string): THREE.Object3D | null {
    const g = this.weapons.get(`${side}|${w}`) ?? (w === "knife" ? null : this.weapons.get(`${side === "CT" ? "T" : "CT"}|${w}`));
    return g ? cloneSkinned(g) : null;
  }
}

// ---------------------------------------------------------------- one player

export interface ActorState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Velocity in Source units/s. */
  vx: number;
  vy: number;
  duck: boolean;
  walking: boolean;
  alive: boolean;
  /** Seconds since death (alive: 0). */
  deadFor: number;
  weapon: string;
  defuser: boolean;
  visible: boolean;
}

const IDQ = new THREE.Quaternion();

/** B_i = (skeleton rest world rotation)^-1 * (model rest world rotation), per skeleton bone (identity when the model lacks it). */
function rebaseRotations(sk: NmSkeleton, bones: (THREE.Bone | null)[]): THREE.Quaternion[] {
  const n = sk.names.length;
  const ws: THREE.Quaternion[] = [];
  const out: THREE.Quaternion[] = [];
  for (let i = 0; i < n; i++) {
    const p = sk.parents[i];
    const l = new THREE.Quaternion().fromArray(sk.refQ, i * 4);
    ws.push(p >= 0 ? ws[p].clone().multiply(l) : l);
  }
  const root = bones[0]?.parent ?? null;
  const wm = (b: THREE.Bone): THREE.Quaternion => {
    const q = b.quaternion.clone();
    for (let o = b.parent; o && o !== root && (o as THREE.Bone).isBone; o = o.parent) q.premultiply(o.quaternion);
    return q;
  };
  for (let i = 0; i < n; i++) {
    const b = bones[i];
    out.push(b ? ws[i].clone().invert().multiply(wm(b)).normalize() : new THREE.Quaternion());
  }
  return out;
}

/**
 * Puts a weapon model on a character's `wpn` bone. The game attaches in the animation skeleton's wpn frame (the model's
 * bone frame differs by `rebase`), and the weapon's root bone sits on that bone: its rest offset from the model origin
 * is only for the inventory pose.
 */
function attachWeapon(bone: THREE.Bone, obj: THREE.Object3D, rebase: THREE.Quaternion) {
  obj.quaternion.copy(rebase).invert();
  obj.traverse((o) => {
    if ((o as THREE.Bone).isBone && !(o.parent as THREE.Bone)?.isBone) o.position.set(0, 0, 0);
  });
  bone.add(obj);
}

const _q = new THREE.Quaternion();
const _p = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _ax = new THREE.Vector3(0, 1, 0);

export class Character {
  /** Placed at the player's feet, rotated by yaw (three space). */
  root = new THREE.Group();
  private inner: THREE.Object3D;
  private bones: (THREE.Bone | null)[];
  /**
   * Per skeleton bone, the rotation from the animation skeleton's bone frame to the model bone's (both rest poses in model
   * space): the model's bones may use other local axes than CS2's animation skeleton (heatel's export re-bases them).
   */
  private rebase: THREE.Quaternion[];
  private pose: Pose;
  private tmp: Pose;
  private phase = Math.random();
  private lib: ActorLibrary;
  side: "CT" | "T";
  private wpnBone: THREE.Bone | null;
  private weaponName = "";
  private weaponObj: THREE.Object3D | null = null;
  private defuser: THREE.Object3D[] = [];
  /** The muzzle in world space (three), updated every frame. */
  muzzle = new THREE.Vector3();

  constructor(lib: ActorLibrary, side: "CT" | "T") {
    this.lib = lib;
    this.side = side;
    const sc = cloneSkinned(lib.agents[side]);
    // Source (Z up) -> three (Y up): (x, y, z) -> (x, z, -y)
    const conv = new THREE.Group();
    conv.rotation.x = -Math.PI / 2;
    conv.add(sc);
    this.inner = conv;
    this.root.add(conv);
    const byName = new Map<string, THREE.Bone>();
    sc.traverse((o) => {
      if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone);
      const n = o.name.toLowerCase();
      if ((o as THREE.Mesh).isMesh || o.children.some((c) => (c as THREE.Mesh).isMesh)) {
        if (n.startsWith("firstperson")) o.visible = false;
        if (n.startsWith("defusekit")) this.defuser.push(o);
      }
    });
    this.bones = lib.skel.names.map((n) => byName.get(n) ?? null);
    this.rebase = rebaseRotations(lib.skel, this.bones);
    this.wpnBone = byName.get("wpn") ?? null;
    const nb = lib.skel.names.length;
    this.pose = new Pose(nb);
    this.tmp = new Pose(nb);
  }

  private setWeapon(w: string) {
    if (w === this.weaponName && (this.weaponObj || !w)) return;
    const obj = w ? this.lib.weapon(this.side, w) : null;
    if (w && !obj) return; // still loading: keep the old one, retry next frame
    if (this.weaponObj) this.weaponObj.removeFromParent();
    this.weaponName = w;
    this.weaponObj = obj;
    const wi = this.lib.skel.index.get("wpn");
    if (obj && this.wpnBone && wi != null) attachWeapon(this.wpnBone, obj, this.rebase[wi]);
  }

  update(s: ActorState, dt: number, time: number) {
    this.root.visible = s.visible;
    if (!s.visible) return;
    const lib = this.lib;
    this.root.position.set(s.x, s.z, -s.y);
    this.root.rotation.set(0, (s.yaw * Math.PI) / 180, 0);
    this.setWeapon(s.alive ? s.weapon : "");
    for (const d of this.defuser) d.visible = s.defuser;
    const set = lib.sets.get(weaponClass(s.weapon)) ?? lib.sets.get("rifle")!;
    const P = this.pose;
    if (!s.alive && lib.death) {
      lib.death.sample(Math.min(1, s.deadFor / lib.death.duration), P, 1, false, false);
    } else {
      const speed = Math.hypot(s.vx, s.vy);
      const gait: Gait = s.duck ? "crouch" : s.walking || speed < 150 ? "walk" : "run";
      const clips = set.move[gait];
      // movement direction relative to the facing: 0 = forward (n), -90 = right (e)
      let rel = speed > 1 ? (Math.atan2(s.vy, s.vx) * 180) / Math.PI - s.yaw : 0;
      rel = ((-rel % 360) + 360) % 360; // clockwise from forward, as DIRS
      const sec = rel / 45;
      const i0 = Math.floor(sec) % 8;
      const i1 = (i0 + 1) % 8;
      const fa = sec - Math.floor(sec);
      const cA = clips[i0], cB = clips[i1];
      const ref = (cA.speed * (1 - fa) + cB.speed * fa) || (gait === "run" ? 230 : gait === "walk" ? 125 : 85);
      const dur = cA.duration * (1 - fa) + cB.duration * fa;
      this.phase += (dt / dur) * Math.min(1.8, Math.max(0.35, speed / ref));
      const moveW = Math.min(1, Math.max(0, (speed - 8) / 60));
      const idle = s.duck ? set.idleCrouch : set.idle;
      idle.sample(time / idle.duration, P, 1 - moveW, false);
      cA.sample(this.phase, P, moveW * (1 - fa), true);
      cB.sample(this.phase, P, moveW * fa, true);
      normalizePose(P);
      this.aim(P, s.pitch);
    }
    this.apply(P);
    // muzzle: the weapon's front, else in front of the eyes
    if (this.weaponObj) {
      this.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.weaponObj);
      const fwd = new THREE.Vector3(Math.cos((s.yaw * Math.PI) / 180), 0, -Math.sin((s.yaw * Math.PI) / 180));
      box.getCenter(this.muzzle).addScaledVector(fwd, box.getSize(new THREE.Vector3()).length() * 0.45);
    } else this.muzzle.set(s.x, s.z + 60, -s.y);
  }

  /** Bends the spine and head toward the view pitch (positive = down), in model space about the character's left axis. */
  private aim(P: Pose, pitch: number) {
    const sk = this.lib.skel;
    const chain = ["spine_1", "spine_2", "spine_3", "neck_0", "head_0"];
    const share = [0.2, 0.2, 0.2, 0.15, 0.25];
    const ang = Math.max(-89, Math.min(89, pitch)) * (Math.PI / 180);
    for (let c = 0; c < chain.length; c++) {
      const i = sk.index.get(chain[c]);
      if (i == null) continue;
      // parent's model-space rotation
      _p.identity();
      const path: number[] = [];
      for (let p = sk.parents[i]; p >= 0; p = sk.parents[p]) path.push(p);
      for (let k = path.length - 1; k >= 0; k--) _p.multiply(_q.fromArray(P.q, path[k] * 4));
      _r.setFromAxisAngle(_ax, ang * share[c]);
      // q' = P^-1 * R * P * q
      _q.fromArray(P.q, i * 4);
      const pinv = _p.clone().invert();
      pinv.multiply(_r).multiply(_p).multiply(_q).normalize();
      pinv.toArray(P.q, i * 4);
    }
  }

  private apply(P: Pose) {
    const b = this.bones;
    const sk = this.lib.skel;
    for (let i = 0; i < b.length; i++) {
      const bone = b[i];
      if (!bone || i === 0) continue; // root_motion stays at the origin: the group carries position and yaw
      const pi = sk.parents[i];
      const bp = pi >= 0 ? this.rebase[pi] : IDQ;
      // model local = B_parent^-1 * skeleton local * B_self
      _p.copy(bp).invert();
      bone.position.fromArray(P.t, i * 3).applyQuaternion(_p);
      bone.quaternion.copy(_p).multiply(_q.fromArray(P.q, i * 4)).multiply(this.rebase[i]);
    }
  }

  dispose() {
    this.root.removeFromParent();
  }
}

// ---------------------------------------------------------------- first person

interface VmRig {
  root: THREE.Object3D;
  /** Agent bones, parents first, with their rest locals. */
  order: { bone: THREE.Bone; vm: number; b: THREE.Quaternion | null; t: THREE.Vector3; q: THREE.Quaternion }[];
  wpn: THREE.Bone | null;
  wpnRebase: THREE.Quaternion;
  weapon: string;
  weaponObj: THREE.Object3D | null;
}

const _m = new THREE.Matrix4();
const _w = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * The game's first-person view: the agent's own first-person arms and sleeves and the weapon, posed by CS2's viewmodel
 * clips (idle, shoot), drawn in a second pass over the world with its own camera so it never clips into walls.
 */
export class ViewModel {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(54, 16 / 9, 0.5, 400);
  private lib: ActorLibrary;
  private rigs: Partial<Record<"CT" | "T", VmRig>> = {};
  private pose: Pose | null = null;
  private wt: Float32Array = new Float32Array(0);
  private wq: Float32Array = new Float32Array(0);
  sun = new THREE.DirectionalLight(0xffffff, 2.2);
  hemi = new THREE.HemisphereLight(0xdfe8ff, 0x51473c, 1.4);

  constructor(lib: ActorLibrary) {
    this.lib = lib;
    this.sun.position.set(-0.4, 1, 0.6);
    this.scene.add(this.hemi, this.sun, this.camera);
    if (lib.vmSkel) {
      const n = lib.vmSkel.names.length;
      this.pose = new Pose(n);
      this.wt = new Float32Array(n * 3);
      this.wq = new Float32Array(n * 4);
    }
  }

  private rig(side: "CT" | "T"): VmRig | null {
    const sk = this.lib.vmSkel;
    if (!sk) return null;
    let r = this.rigs[side];
    if (r) return r;
    const sc = cloneSkinned(this.lib.agents[side]);
    const byName = new Map<string, THREE.Bone>();
    sc.traverse((o) => {
      if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone);
      if ((o as THREE.Mesh).isMesh) {
        const n = (o.name + " " + (o.parent?.name ?? "")).toLowerCase();
        o.visible = n.includes("firstperson");
        o.castShadow = false;
      }
    });
    // frames of the model's bones vs CS2's rig, from the third-person skeleton (same bone axes in both rigs)
    const wb = this.lib.skel.names.map((n) => byName.get(n) ?? null);
    const reb = rebaseRotations(this.lib.skel, wb);
    const bOf = new Map<string, THREE.Quaternion>();
    this.lib.skel.names.forEach((n, i) => {
      if (wb[i]) bOf.set(n, reb[i]);
    });
    const order: VmRig["order"] = [];
    sc.traverse((o) => {
      const b = o as THREE.Bone;
      if (!b.isBone) return;
      order.push({ bone: b, vm: sk.index.get(b.name) ?? -1, b: bOf.get(b.name) ?? null, t: b.position.clone(), q: b.quaternion.clone() });
    });
    // Source (x fwd, y left, z up) -> camera space (x right, y up, -z forward)
    const conv = new THREE.Group();
    conv.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)));
    conv.add(sc);
    conv.visible = false;
    this.camera.add(conv);
    r = { root: conv, order, wpn: byName.get("wpn") ?? null, wpnRebase: bOf.get("wpn") ?? new THREE.Quaternion(), weapon: "", weaponObj: null };
    this.rigs[side] = r;
    return r;
  }

  /** Poses the first-person view; false when there is nothing to draw (clips still loading, no weapon). */
  update(o: { side: "CT" | "T"; weapon: string; shotAge: number | null; speed: number; time: number; aspect: number; sunColor?: THREE.Color }): boolean {
    for (const k of ["CT", "T"] as const) {
      const rr = this.rigs[k];
      if (rr) rr.root.visible = false;
    }
    const sk = this.lib.vmSkel;
    const P = this.pose;
    if (!sk || !P || !o.weapon) return false;
    const clips = this.lib.viewClipsFor(o.weapon, o.side);
    const r = this.rig(o.side);
    if (!clips || !r) return false;
    if (r.weapon !== o.weapon || !r.weaponObj) {
      const obj = this.lib.weapon(o.side, o.weapon);
      if (obj) {
        r.weaponObj?.removeFromParent();
        r.weapon = o.weapon;
        r.weaponObj = obj;
        obj.traverse((x) => {
          if ((x as THREE.Mesh).isMesh) x.castShadow = false;
        });
        if (r.wpn) attachWeapon(r.wpn, obj, r.wpnRebase);
      } else if (r.weapon !== o.weapon) return false;
    }
    r.root.visible = true;
    if (o.shotAge != null && clips.shoot && o.shotAge < clips.shoot.duration) clips.shoot.sample(o.shotAge / clips.shoot.duration, P, 1, false, false);
    else clips.idle.sample(o.time / clips.idle.duration, P, 1, false);
    // world (viewmodel space) transforms of CS2's rig
    const n = sk.names.length;
    for (let i = 0; i < n; i++) {
      const p = sk.parents[i];
      _q.fromArray(P.q, i * 4);
      _v.fromArray(P.t, i * 3);
      if (p >= 0) {
        _p.fromArray(this.wq, p * 4);
        _v.applyQuaternion(_p).add(_s.fromArray(this.wt, p * 3));
        _q.premultiply(_p);
      }
      _q.toArray(this.wq, i * 4);
      _v.toArray(this.wt, i * 3);
    }
    // drive the agent's bones: matched ones take the rig's world transform, the rest keep their rest locals
    const world = new Map<THREE.Object3D, THREE.Matrix4>();
    for (const e of r.order) {
      const pw = world.get(e.bone.parent!) ?? null;
      const W = new THREE.Matrix4();
      if (e.vm >= 0 && e.b) {
        _q.fromArray(this.wq, e.vm * 4).multiply(e.b);
        W.compose(_v.fromArray(this.wt, e.vm * 3), _q, _one);
        _m.copy(pw ?? _w.identity()).invert().multiply(W);
        _m.decompose(e.bone.position, e.bone.quaternion, _s);
      } else {
        e.bone.position.copy(e.t);
        e.bone.quaternion.copy(e.q);
        W.compose(e.t, e.q, _one);
        if (pw) W.premultiply(pw);
      }
      world.set(e.bone, W);
    }
    // a little walk bob, as the game's view does
    const bob = Math.min(1, o.speed / 250);
    r.root.position.set(Math.sin(o.time * 8.5) * 0.35 * bob, -Math.abs(Math.cos(o.time * 8.5)) * 0.5 * bob, 0);
    this.camera.aspect = o.aspect;
    // CS2's viewmodel_fov 68 (horizontal at 4:3)
    this.camera.fov = (2 * Math.atan(Math.tan((68 * Math.PI) / 360) / (4 / 3)) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
    if (o.sunColor) this.sun.color.copy(o.sunColor);
    return true;
  }
}
