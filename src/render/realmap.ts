import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { MapProgress, MapQuality, MapSceneExtras } from "../lib/contract";
import { getMapScene } from "../lib/backend";

/**
 * The real CS2 map (exported by the backend from the user's own install as binary glTF), prepared for the 3D view:
 * geometry is already in three.js world space (Source units, (x, z, -y)), batched by material and cell.
 */
export interface RealMapAsset {
  key: string;
  map: string;
  root: THREE.Group;
  extras: MapSceneExtras;
  stats: { triangles: number; drawCalls: number; materials: number; textures: number; textureMB: number; glbMB: number; fetchMs: number; parseMs: number };
}

let ktx2: KTX2Loader | null = null;
const cache = new Map<string, Promise<RealMapAsset>>();
let current: RealMapAsset | null = null;

/** Whether BC1/BC3 sRGB textures can stay compressed on this GPU (else the backend sends JPEG/PNG). */
export function compressedTexturesOk(renderer: THREE.WebGLRenderer): boolean {
  const gl = renderer.getContext();
  return !!gl.getExtension("WEBGL_compressed_texture_s3tc") && !!gl.getExtension("WEBGL_compressed_texture_s3tc_srgb");
}

/** The asset the 3D view currently shows (used by the video exporter). */
export function currentRealMap(): RealMapAsset | null {
  return current;
}

function prepare(gltf: GLTF, renderer: THREE.WebGLRenderer): { root: THREE.Group; tris: number; draws: number; mats: number; texs: number } {
  const root = new THREE.Group();
  root.name = "realmap";
  const scene = gltf.scene;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  let tris = 0;
  let draws = 0;
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = mesh.material as THREE.MeshStandardMaterial;
    const ex = (m.userData ?? {}) as { overlay?: boolean; additive?: boolean; kind?: string };
    draws++;
    tris += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!mats.has(m)) {
      mats.add(m);
      m.vertexColors = !!mesh.geometry.attributes.color;
      if (m.map) {
        texs.add(m.map);
        m.map.anisotropy = aniso;
        m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
        if ((m.map as THREE.CompressedTexture).isCompressedTexture) m.map.generateMipmaps = false;
        m.map.needsUpdate = true;
      }
      m.envMapIntensity = 0;
      if (m.transparent) {
        m.depthWrite = false;
        if (ex.additive) m.blending = THREE.AdditiveBlending;
      }
      if (ex.kind === "water") {
        m.roughness = 0.12;
        m.metalness = 0.1;
        m.transparent = true;
        m.opacity = Math.min(m.opacity, 0.72);
        m.depthWrite = false;
      } else if (ex.kind === "glass") {
        m.roughness = 0.05;
        m.transparent = true;
        m.depthWrite = false;
      }
      if (ex.overlay) {
        m.polygonOffset = true;
        m.polygonOffsetFactor = -2;
        m.polygonOffsetUnits = -4;
        m.depthWrite = false;
        if (m.alphaTest === 0 && !m.transparent) m.transparent = true;
      }
    }
    if (m.transparent || ex.overlay) {
      mesh.castShadow = false;
      mesh.renderOrder = ex.overlay ? 1 : 2;
    }
  });
  scene.updateMatrixWorld(true);
  root.add(scene);
  return { root, tris: Math.round(tris), draws, mats: mats.size, texs: texs.size };
}

/**
 * Fetches (backend export or cache / browser fixture) and parses the map. Cached per map + quality + texture format.
 * Rejects with a Turkish message.
 */
export function loadRealMap(renderer: THREE.WebGLRenderer, map: string, quality: MapQuality, onProgress?: (p: MapProgress) => void): Promise<RealMapAsset> {
  const tex = compressedTexturesOk(renderer) ? "ktx2" : "image";
  const key = `${map}|${quality}|${tex}`;
  const hit = cache.get(key);
  if (hit) return hit.then((a) => ((current = a), a));
  const p = (async () => {
    const t0 = performance.now();
    const buf = await getMapScene(map, quality, tex, onProgress);
    const t1 = performance.now();
    onProgress?.({ map, stage: "Harita sahnesi hazırlanıyor", pct: 0.97 });
    if (!ktx2) {
      ktx2 = new KTX2Loader();
      ktx2.detectSupport(renderer);
    }
    const loader = new GLTFLoader();
    loader.setKTX2Loader(ktx2);
    let gltf: GLTF;
    try {
      gltf = await loader.parseAsync(buf, "");
    } catch (e) {
      throw new Error("Harita sahnesi açılamadı: " + String((e as Error)?.message ?? e));
    }
    const extras = (gltf.scene.userData?.rewind ?? (gltf.scenes?.[0]?.userData as any)?.rewind) as MapSceneExtras | undefined;
    if (!extras) throw new Error("Harita dosyası Rewind biçiminde değil");
    const prep = prepare(gltf, renderer);
    const st = extras.stats as Record<string, number>;
    const asset: RealMapAsset = {
      key,
      map,
      root: prep.root,
      extras,
      stats: {
        triangles: prep.tris,
        drawCalls: prep.draws,
        materials: prep.mats,
        textures: prep.texs,
        textureMB: Math.round(((st?.textureGpuBytes ?? 0) / 1048576) * 10) / 10,
        glbMB: Math.round((buf.byteLength / 1048576) * 10) / 10,
        fetchMs: Math.round(t1 - t0),
        parseMs: Math.round(performance.now() - t1),
      },
    };
    onProgress?.({ map, stage: "Hazır", pct: 1 });
    return asset;
  })();
  // keep only one map in memory: drop other entries (their GPU resources are freed by disposeOthers)
  for (const k of [...cache.keys()]) if (k !== key) {
    const old = cache.get(k)!;
    cache.delete(k);
    old.then(disposeAsset).catch(() => {});
  }
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p.then((a) => ((current = a), a));
}

function disposeAsset(a: RealMapAsset) {
  if (current === a) current = null;
  a.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const m = mesh.material as THREE.MeshStandardMaterial;
    m.map?.dispose();
    m.dispose();
  });
}

/** Clears the current asset reference (fallback / simple view). Resources stay cached for a quick toggle back. */
export function clearCurrentRealMap() {
  current = null;
}

/** Drops every cached map (frees GPU resources); the next load fetches again. */
export function forgetRealMaps() {
  for (const p of cache.values()) p.then(disposeAsset).catch(() => {});
  cache.clear();
  current = null;
}
(window as any).__forgetRealMaps = forgetRealMaps;
