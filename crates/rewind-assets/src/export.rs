//! Converting a CS2 map (world nodes, aggregates, entity props) into one binary glTF scene in
//! three.js coordinates (x, z, -y in Source units), batched by material and spatial cell.
//!
//! World/aggregate/LoD/layer handling follows Source 2 Viewer (ValveResourceFormat, MIT):
//! `WorldNodeLoader.cs` and `SceneAggregate.cs`.

use crate::game::{Files, Game};
use crate::glb::{self, GlbBuilder};
use crate::material::{self, AlphaMode, MatInfo};
use crate::texture::{self, TexFormat};
use crate::{Error, Quality};
use heatel::kv3::Value;
use heatel::{Model, Resource, Texture};
use rayon::prelude::*;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

/// Bump when the produced scene changes for the same input (invalidates caches).
pub const EXPORT_REV: u32 = 4;

/// A 3x4 affine transform, rows `[R | t]`, Source space.
pub type Affine = [[f32; 4]; 3];
const IDENTITY: Affine = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]];

pub type Progress<'a> = &'a (dyn Fn(&str, f32) + Sync);

#[derive(Debug, Clone, Copy)]
pub struct ExportOptions {
    pub quality: Quality,
    pub textures: TexFormat,
    /// Include models placed by entities (props, doors, breakables).
    pub entity_props: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self { quality: Quality::Medium, textures: TexFormat::Ktx2, entity_props: true }
    }
}

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStats {
    pub world_nodes: usize,
    pub scene_objects: usize,
    pub aggregate_fragments: usize,
    pub entity_props: usize,
    pub hidden_layer_objects: usize,
    pub lod_skipped_fragments: usize,
    pub models: usize,
    pub models_missing: usize,
    pub materials: usize,
    pub materials_skipped: usize,
    pub textures: usize,
    pub textures_failed: usize,
    pub texture_gpu_bytes: usize,
    pub texture_file_bytes: usize,
    pub batches: usize,
    pub vertices: usize,
    pub triangles: usize,
    pub glb_bytes: usize,
    pub millis: u64,
    pub layers: Vec<String>,
    pub shaders: Vec<(String, usize)>,
    pub warnings: Vec<String>,
}

pub struct Exported {
    pub glb: Vec<u8>,
    pub stats: ExportStats,
}

/// One thing to draw: a model placed in the world.
#[derive(Clone)]
struct Inst {
    model: String,
    xf: Affine,
    tint: [f32; 4],
    /// Only this draw call of the model's first mesh (aggregate fragments).
    draw_call: Option<usize>,
    skin: Option<String>,
    /// (mesh, draw call) -> material
    overrides: Vec<(usize, usize, String)>,
}

/// Decoded geometry of one draw call in model space (Source units).
struct Prim {
    mesh: usize,
    dc: usize,
    material: String,
    pos: Vec<[f32; 3]>,
    nrm: Vec<[f32; 3]>,
    uv: Vec<[f32; 2]>,
    col: Option<Vec<[f32; 4]>>,
    idx: Vec<u32>,
    tint: Option<[f32; 4]>,
    center: [f32; 3],
}

struct ModelGeom {
    prims: Vec<Prim>,
    groups: Vec<(String, Vec<String>)>,
}

// ---------------------------------------------------------------- helpers on KV3 values

fn arr(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).unwrap_or_default()
}
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        o => o.as_f64(),
    }
}
fn s(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}
/// `n` numbers from an array or a space separated string.
fn nums<const N: usize>(v: Option<&Value>, default: [f32; N]) -> [f32; N] {
    match v {
        Some(Value::Array(items)) if items.len() >= N => std::array::from_fn(|i| num(items.get(i)).unwrap_or(default[i] as f64) as f32),
        Some(Value::String(t)) => {
            let p: Vec<f32> = t.split_whitespace().filter_map(|x| x.parse().ok()).collect();
            if p.len() >= N {
                std::array::from_fn(|i| p[i])
            } else {
                default
            }
        }
        _ => default,
    }
}

fn affine(v: Option<&Value>) -> Option<Affine> {
    let items = v?.as_array()?;
    let flat: Vec<f32> = match items.first()?.as_array() {
        Some(_) => items.iter().flat_map(|r| arr(Some(r)).iter().map(|x| x.as_f64().unwrap_or(0.0) as f32)).collect(),
        None => items.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect(),
    };
    if flat.len() < 12 || flat.iter().any(|f| !f.is_finite()) {
        return None;
    }
    Some(std::array::from_fn(|r| std::array::from_fn(|c| flat[r * 4 + c])))
}

#[cfg(test)]
fn mul(a: &Affine, b: &Affine) -> Affine {
    std::array::from_fn(|i| {
        std::array::from_fn(|j| {
            let mut v = (0..3).map(|k| a[i][k] * b[k][j]).sum::<f32>();
            if j == 3 {
                v += a[i][3];
            }
            v
        })
    })
}

fn det3(a: &Affine) -> f32 {
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
}

/// Inverse-transpose of the linear part (for normals), unnormalized.
fn normal_matrix(a: &Affine) -> [[f32; 3]; 3] {
    // cofactor matrix == det * inverse-transpose
    let m = |r: usize, c: usize| a[r][c];
    [
        [m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1), m(1, 2) * m(2, 0) - m(1, 0) * m(2, 2), m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0)],
        [m(0, 2) * m(2, 1) - m(0, 1) * m(2, 2), m(0, 0) * m(2, 2) - m(0, 2) * m(2, 0), m(0, 1) * m(2, 0) - m(0, 0) * m(2, 1)],
        [m(0, 1) * m(1, 2) - m(0, 2) * m(1, 1), m(0, 2) * m(1, 0) - m(0, 0) * m(1, 2), m(0, 0) * m(1, 1) - m(0, 1) * m(1, 0)],
    ]
}

/// Source entity transform from origin/angles/scales (pitch yaw roll, degrees).
pub fn entity_affine(origin: [f32; 3], angles: [f32; 3], scales: [f32; 3]) -> Affine {
    let [p, y, r] = angles.map(f32::to_radians);
    let (sp, cp) = p.sin_cos();
    let (sy, cy) = y.sin_cos();
    let (sr, cr) = r.sin_cos();
    // columns: forward, left, up (Source AngleMatrix)
    let rot = [
        [cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
        [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
        [-sp, sr * cp, cr * cp],
    ];
    std::array::from_fn(|i| [rot[i][0] * scales[0], rot[i][1] * scales[1], rot[i][2] * scales[2], origin[i]])
}

/// heatel converts vertices to glTF metres (`(y, z, x) * 0.0254`); back to Source units.
#[inline]
fn from_gltf(g: [f32; 3], scale: bool) -> [f32; 3] {
    let k = if scale { 1.0 / 0.0254 } else { 1.0 };
    [g[2] * k, g[0] * k, g[1] * k]
}

/// Source -> three.js (Y up): (x, z, -y).
#[inline]
pub fn to_three(p: [f32; 3]) -> [f32; 3] {
    [p[0], p[2], -p[1]]
}

// ---------------------------------------------------------------- scene collection

struct Collected {
    insts: Vec<Inst>,
    entities: Vec<Value>,
    bounds: Option<([f32; 3], [f32; 3])>,
}

fn read_resource_data(files: &Files, path: &str) -> Option<Value> {
    let b = files.read(path)?;
    let r = Resource::parse(&b).ok()?;
    r.data()?.ok()
}

fn collect(files: &Files, map: &str, opts: &ExportOptions, stats: &mut ExportStats) -> Result<Collected, Error> {
    let mut world_path = format!("maps/{map}/world.vwrld");
    if files.map.get(&format!("{world_path}_c")).is_none() {
        // packages whose map folder differs from the package name
        if let Some(e) = files.map.entries().find(|e| e.name() == "world" && e.ext() == "vwrld_c") {
            world_path = format!("{}/world.vwrld", e.dir());
        }
    }
    let world = read_resource_data(files, &world_path).ok_or_else(|| Error::Parse(format!("{world_path}_c okunamadı")))?;

    // entities first: info_world_layer decides which layers are visible
    let mut entities: Vec<Value> = Vec::new();
    let mut lump_queue: Vec<String> = arr(world.get("m_entityLumps")).iter().filter_map(Value::as_str).map(str::to_owned).collect();
    let mut seen_lumps = HashSet::new();
    while let Some(l) = lump_queue.pop() {
        if !seen_lumps.insert(l.to_ascii_lowercase()) || seen_lumps.len() > 256 {
            continue;
        }
        let Some(b) = files.read(&l) else { continue };
        let Ok(r) = Resource::parse(&b) else { continue };
        match heatel::world::EntityLump::read(&r) {
            Ok(lump) => {
                entities.extend(lump.entities);
                lump_queue.extend(lump.children);
            }
            Err(e) => stats.warnings.push(format!("{l}: {e}")),
        }
    }
    let mut hidden_layers: HashSet<String> = HashSet::new();
    for e in &entities {
        if s(e.get("classname")) == Some("info_world_layer") {
            let name = s(e.get("layername")).or(s(e.get("worldlayername"))).unwrap_or_default().to_ascii_lowercase();
            let visible = num(e.get("initialstate")).or(num(e.get("visibleonspawn"))).or(num(e.get("spawnflags")).map(|f| ((f as i64) & 1) as f64)).unwrap_or(1.0);
            if !name.is_empty() && visible == 0.0 {
                hidden_layers.insert(name);
            }
        }
    }

    let mut insts = Vec::new();
    let mut bounds: Option<([f32; 3], [f32; 3])> = None;
    let mut layer_names = HashSet::new();
    for node in arr(world.get("m_worldNodes")) {
        let (mn, mx) = (nums::<3>(node.get("m_vMinBounds"), [0.0; 3]), nums::<3>(node.get("m_vMaxBounds"), [0.0; 3]));
        if mn != mx {
            bounds = Some(match bounds {
                None => (mn, mx),
                Some((a, b)) => (std::array::from_fn(|i| a[i].min(mn[i])), std::array::from_fn(|i| b[i].max(mx[i]))),
            });
        }
        let Some(prefix) = s(node.get("m_worldNodePrefix")) else { continue };
        let path = format!("{}.vwnod", prefix.replace('\\', "/"));
        let Some(data) = read_resource_data(files, &path) else {
            stats.warnings.push(format!("{path}_c okunamadı"));
            continue;
        };
        stats.world_nodes += 1;
        let layers: Vec<String> = arr(data.get("m_layerNames")).iter().map(|v| v.as_str().unwrap_or_default().to_ascii_lowercase()).collect();
        layer_names.extend(layers.iter().cloned());
        let layer_visible = |i: i64| -> bool {
            if i < 0 {
                return true;
            }
            match layers.get(i as usize) {
                Some(n) => !hidden_layers.contains(n),
                None => true,
            }
        };
        let layer_idx = arr(data.get("m_sceneObjectLayerIndices"));
        let mut overrides: HashMap<usize, Vec<(usize, usize, String)>> = HashMap::new();
        for o in arr(data.get("m_materialOverrides")) {
            let (Some(so), Some(m)) = (num(o.get("m_nSceneObjectIndex")), s(o.get("m_pMaterial"))) else { continue };
            let sub = num(o.get("m_nSubSceneObject")).unwrap_or(0.0) as usize;
            let dc = num(o.get("m_nDrawCallIndex")).unwrap_or(0.0) as usize;
            overrides.entry(so as usize).or_default().push((sub, dc, m.to_string()));
        }
        for (i, so) in arr(data.get("m_sceneObjects")).iter().enumerate() {
            let model = s(so.get("m_renderableModel")).unwrap_or_default();
            if model.is_empty() {
                continue;
            }
            let li = num(layer_idx.get(i)).unwrap_or(-1.0) as i64;
            if !layer_visible(li) {
                stats.hidden_layer_objects += 1;
                continue;
            }
            let Some(xf) = affine(so.get("m_vTransform")) else { continue };
            let mut tint = nums::<4>(so.get("m_vTintColor"), [1.0; 4]);
            if tint[3] == 0.0 {
                tint = [1.0; 4];
            }
            let tint = [material::srgb_to_linear(tint[0].clamp(0.0, 1.0)), material::srgb_to_linear(tint[1].clamp(0.0, 1.0)), material::srgb_to_linear(tint[2].clamp(0.0, 1.0)), tint[3].clamp(0.0, 1.0)];
            let skin = s(so.get("m_skin")).filter(|x| !x.is_empty() && *x != "default").map(str::to_owned);
            stats.scene_objects += 1;
            insts.push(Inst { model: model.to_string(), xf, tint, draw_call: None, skin, overrides: overrides.remove(&i).unwrap_or_default() });
        }
        for agg in arr(data.get("m_aggregateSceneObjects")) {
            let Some(model) = s(agg.get("m_renderableModel")).filter(|m| !m.is_empty()) else { continue };
            let li = num(agg.get("m_nLayer")).unwrap_or(-1.0) as i64;
            let frags = arr(agg.get("m_aggregateMeshes"));
            if !layer_visible(li) {
                stats.hidden_layer_objects += frags.len();
                continue;
            }
            let transforms = arr(agg.get("m_fragmentTransforms"));
            let mut next = 0usize;
            for f in frags {
                let has_xf = f.get("m_bHasTransform").and_then(Value::as_bool).unwrap_or(false);
                let xf = if has_xf {
                    let t = affine(transforms.get(next));
                    next += 1;
                    t
                } else {
                    Some(IDENTITY)
                };
                let Some(xf) = xf else { continue };
                // highest-detail LoD only (mask 0 = not LoD managed)
                let mask = num(f.get("m_nLODGroupMask")).unwrap_or(0.0) as u64;
                if mask != 0 && mask & 1 == 0 {
                    stats.lod_skipped_fragments += 1;
                    continue;
                }
                let Some(dc) = num(f.get("m_nDrawCallIndex")) else { continue };
                let t = nums::<3>(f.get("m_vTintColor"), [255.0; 3]);
                let tint = [material::srgb_to_linear((t[0] / 255.0).clamp(0.0, 1.0)), material::srgb_to_linear((t[1] / 255.0).clamp(0.0, 1.0)), material::srgb_to_linear((t[2] / 255.0).clamp(0.0, 1.0)), 1.0];
                stats.aggregate_fragments += 1;
                insts.push(Inst { model: model.to_string(), xf, tint, draw_call: Some(dc as usize), skin: None, overrides: Vec::new() });
            }
        }
    }
    let mut ln: Vec<String> = layer_names.into_iter().collect();
    ln.sort();
    stats.layers = ln;

    if opts.entity_props {
        for e in &entities {
            let class = s(e.get("classname")).unwrap_or_default();
            let Some(model) = s(e.get("model")).filter(|m| m.ends_with(".vmdl")) else { continue };
            if !entity_draws(class, e) {
                continue;
            }
            let xf = entity_affine(nums(e.get("origin"), [0.0; 3]), nums(e.get("angles"), [0.0; 3]), {
                let sc = nums(e.get("scales"), [1.0; 3]);
                let ms = num(e.get("modelscale")).unwrap_or(1.0) as f32;
                sc.map(|v| v * if ms > 0.0 { ms } else { 1.0 })
            });
            let c = nums(e.get("rendercolor"), [255.0; 3]);
            let mut amt = num(e.get("renderamt")).unwrap_or(255.0) as f32;
            if amt > 1.0 {
                amt /= 255.0;
            }
            let tint = [material::srgb_to_linear(c[0] / 255.0), material::srgb_to_linear(c[1] / 255.0), material::srgb_to_linear(c[2] / 255.0), amt.clamp(0.0, 1.0)];
            if tint[3] <= 0.01 {
                continue;
            }
            let skin = s(e.get("skin")).filter(|x| !matches!(*x, "" | "0" | "default")).map(str::to_owned).or_else(|| num(e.get("skin")).filter(|v| *v > 0.0).map(|v| (v as i64).to_string()));
            stats.entity_props += 1;
            insts.push(Inst { model: model.to_string(), xf, tint, draw_call: None, skin, overrides: Vec::new() });
        }
    }
    Ok(Collected { insts, entities, bounds })
}

/// Whether an entity with a model is visible geometry when the round starts.
fn entity_draws(class: &str, e: &Value) -> bool {
    let c = class.to_ascii_lowercase();
    if c.starts_with("trigger_")
        || c.starts_with("info_")
        || c.starts_with("logic_")
        || c.starts_with("point_")
        || c.starts_with("env_")
        || c.starts_with("weapon_")
        || c.starts_with("item_")
        || c.starts_with("hostage")
        || c.starts_with("chicken")
        || c.starts_with("npc_")
        || matches!(c.as_str(), "func_buyzone" | "func_bomb_target" | "func_hostage_rescue" | "func_clip_vphysics" | "func_nav_blocker" | "func_nav_markup" | "func_occluder" | "func_precipitation" | "func_dustcloud" | "func_dustmotes" | "func_areaportal" | "func_ladder" | "func_water_analog" | "csgo_player_previewmodel" | "prop_ragdoll" | "planted_c4" | "func_tracktrain" | "light_environment" | "skybox_reference" | "sky_camera" | "func_lod")
    {
        return false;
    }
    let disabled = e.get("StartDisabled").or(e.get("startdisabled")).and_then(|v| num(Some(v))).unwrap_or(0.0) != 0.0;
    let rendermode_none = num(e.get("rendermode")).is_some_and(|m| m as i64 == 10);
    let hidden = e.get("disableshadows").is_none() && num(e.get("renderamt")).is_some_and(|a| a <= 0.0);
    !(disabled || rendermode_none || hidden)
}

// ---------------------------------------------------------------- geometry

fn load_model(files: &Files, path: &str) -> Option<ModelGeom> {
    let bytes = files.read(path)?;
    let res = Resource::parse(&bytes).ok()?;
    let model = Model::read(&res).ok()?;
    let mut prims = Vec::new();
    for (mi, mesh) in model.meshes.iter().enumerate() {
        for (di, p) in mesh.primitives.iter().enumerate() {
            let Some(v) = mesh.vertices.get(p.vertices) else { continue };
            if v.positions.is_empty() || p.indices.len() < 3 {
                continue;
            }
            // compact the vertices this draw call uses
            let mut remap: HashMap<u32, u32> = HashMap::with_capacity(p.indices.len());
            let mut order: Vec<u32> = Vec::new();
            let idx: Vec<u32> = p
                .indices
                .iter()
                .map(|&i| {
                    *remap.entry(i).or_insert_with(|| {
                        order.push(i);
                        (order.len() - 1) as u32
                    })
                })
                .collect();
            let pick3 = |src: &[[f32; 3]], scale: bool| -> Vec<[f32; 3]> { order.iter().map(|&i| from_gltf(src.get(i as usize).copied().unwrap_or([0.0; 3]), scale)).collect() };
            let pos = pick3(&v.positions, true);
            let nrm = match &v.normals {
                Some(n) => pick3(n, false),
                None => Vec::new(),
            };
            let uv = match v.uvs.first() {
                Some(u) => order.iter().map(|&i| u.get(i as usize).copied().unwrap_or([0.0; 2])).collect(),
                None => Vec::new(),
            };
            let col = v.extra.iter().find(|a| a.name == "COLOR_0" && a.width >= 3).map(|a| order.iter().map(|&i| a.values.get(i as usize).copied().unwrap_or([1.0; 4])).collect::<Vec<_>>());
            let mut c = [0.0f32; 3];
            for q in &pos {
                for k in 0..3 {
                    c[k] += q[k];
                }
            }
            let n = pos.len().max(1) as f32;
            prims.push(Prim { mesh: mi, dc: di, material: p.material.clone(), pos, nrm, uv, col, idx, tint: p.tint, center: c.map(|x| x / n) });
        }
    }
    Some(ModelGeom { prims, groups: model.material_groups.clone() })
}

/// Material a primitive uses for an instance (skin and node overrides applied).
fn prim_material<'a>(inst: &'a Inst, prim: &'a Prim, groups: &'a [(String, Vec<String>)]) -> &'a str {
    if let Some((_, _, m)) = inst.overrides.iter().find(|(m, d, _)| *m == prim.mesh && *d == prim.dc) {
        return m;
    }
    if let Some(skin) = &inst.skin {
        let group = groups.iter().find(|(n, _)| n.eq_ignore_ascii_case(skin)).or_else(|| skin.parse::<usize>().ok().and_then(|i| groups.get(i)));
        if let (Some((_, def)), Some((_, sk))) = (groups.first(), group) {
            if let Some(i) = def.iter().position(|m| *m == prim.material) {
                if let Some(m) = sk.get(i) {
                    return m;
                }
            }
        }
    }
    &prim.material
}

#[derive(Default)]
struct Batch {
    pos: Vec<f32>,
    nrm: Vec<i8>,
    uv: Vec<f32>,
    col: Vec<u8>,
    idx: Vec<u32>,
    min: [f32; 3],
    max: [f32; 3],
}

impl Batch {
    fn verts(&self) -> usize {
        self.pos.len() / 3
    }
}

fn q8(v: f32) -> i8 {
    (v.clamp(-1.0, 1.0) * 127.0).round() as i8
}
fn u8c(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn append(b: &mut Batch, prim: &Prim, xf: &Affine, tint: [f32; 4]) {
    if b.pos.is_empty() {
        b.min = [f32::MAX; 3];
        b.max = [f32::MIN; 3];
    }
    let base = b.verts() as u32;
    let nm = normal_matrix(xf);
    let flip = det3(xf) < 0.0;
    let ptint = prim.tint.unwrap_or([1.0; 4]);
    for (i, p) in prim.pos.iter().enumerate() {
        let w = [
            xf[0][0] * p[0] + xf[0][1] * p[1] + xf[0][2] * p[2] + xf[0][3],
            xf[1][0] * p[0] + xf[1][1] * p[1] + xf[1][2] * p[2] + xf[1][3],
            xf[2][0] * p[0] + xf[2][1] * p[1] + xf[2][2] * p[2] + xf[2][3],
        ];
        let t = to_three(w);
        for k in 0..3 {
            b.min[k] = b.min[k].min(t[k]);
            b.max[k] = b.max[k].max(t[k]);
        }
        b.pos.extend_from_slice(&t);
        let n = prim.nrm.get(i).copied().unwrap_or([0.0, 0.0, 1.0]);
        let wn = [nm[0][0] * n[0] + nm[0][1] * n[1] + nm[0][2] * n[2], nm[1][0] * n[0] + nm[1][1] * n[1] + nm[1][2] * n[2], nm[2][0] * n[0] + nm[2][1] * n[1] + nm[2][2] * n[2]];
        let l = (wn[0] * wn[0] + wn[1] * wn[1] + wn[2] * wn[2]).sqrt().max(1e-12);
        let tn = to_three([wn[0] / l, wn[1] / l, wn[2] / l]);
        b.nrm.extend_from_slice(&[q8(tn[0]), q8(tn[1]), q8(tn[2]), 0]);
        let uv = prim.uv.get(i).copied().unwrap_or([0.0; 2]);
        b.uv.extend_from_slice(&uv);
        let vc = prim.col.as_ref().and_then(|c| c.get(i)).copied().unwrap_or([1.0; 4]);
        b.col.extend_from_slice(&[u8c(vc[0] * tint[0] * ptint[0]), u8c(vc[1] * tint[1] * ptint[1]), u8c(vc[2] * tint[2] * ptint[2]), u8c(tint[3] * ptint[3] * if prim.col.is_some() { vc[3] } else { 1.0 })]);
    }
    for t in prim.idx.chunks_exact(3) {
        if flip {
            b.idx.extend_from_slice(&[base + t[0], base + t[2], base + t[1]]);
        } else {
            b.idx.extend_from_slice(&[base + t[0], base + t[1], base + t[2]]);
        }
    }
}

// ---------------------------------------------------------------- environment from entities

fn env_extras(entities: &[Value]) -> serde_json::Value {
    const KEEP: [&str; 14] = [
        "light_environment",
        "env_sky",
        "env_cubemap_fog",
        "env_gradient_fog",
        "env_fog_controller",
        "env_volumetric_fog_controller",
        "env_tonemap_controller2",
        "env_tonemap_controller",
        "post_processing_volume",
        "env_global_light",
        "info_player_terrorist",
        "info_player_counterterrorist",
        "worldspawn",
        "env_sun",
    ];
    let mut raw = Vec::new();
    let mut spawns_t = Vec::new();
    let mut spawns_ct = Vec::new();
    let mut sun = serde_json::Value::Null;
    let mut fog = serde_json::Value::Null;
    let mut sky = serde_json::Value::Null;
    for e in entities {
        let class = s(e.get("classname")).unwrap_or_default();
        if !KEEP.contains(&class) {
            continue;
        }
        let origin = nums::<3>(e.get("origin"), [0.0; 3]);
        match class {
            "info_player_terrorist" => spawns_t.push(origin),
            "info_player_counterterrorist" => spawns_ct.push(origin),
            "light_environment" | "env_global_light" | "env_sun" if sun.is_null() => {
                let a = nums::<3>(e.get("angles"), [50.0, 30.0, 0.0]);
                let pitch = num(e.get("pitch")).map(|p| p as f32).unwrap_or(a[0]);
                let (p, y) = (pitch.to_radians(), a[1].to_radians());
                // direction the light travels
                let fwd = [p.cos() * y.cos(), p.cos() * y.sin(), -p.sin()];
                let to_sun = to_three([-fwd[0], -fwd[1], -fwd[2]]);
                let c = nums::<4>(e.get("color"), [255.0, 255.0, 255.0, 255.0]);
                let c = if c == [255.0; 4] { nums::<4>(e.get("_light"), [255.0, 248.0, 230.0, 255.0]) } else { c };
                let bright = num(e.get("brightness")).unwrap_or(1.0);
                let amb = nums::<4>(e.get("ambient_color"), nums::<4>(e.get("skycolor"), [-1.0; 4]));
                sun = json!({ "toSun": to_sun, "color": [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0], "brightness": bright, "ambient": if amb[0] >= 0.0 { json!([amb[0]/255.0, amb[1]/255.0, amb[2]/255.0]) } else { serde_json::Value::Null } });
            }
            "env_sky" if sky.is_null() => {
                let t = nums::<3>(e.get("tint_color"), [255.0; 3]);
                sky = json!({ "material": s(e.get("skyname")), "tint": [t[0]/255.0, t[1]/255.0, t[2]/255.0], "brightness": num(e.get("brightnessscale")).unwrap_or(1.0) });
            }
            "env_cubemap_fog" | "env_gradient_fog" | "env_fog_controller" if fog.is_null() => {
                let start = num(e.get("cubemapfogstartdistance")).or(num(e.get("fogstart"))).or(num(e.get("fog_start_distance")));
                let end = num(e.get("cubemapfogenddistance")).or(num(e.get("fogend"))).or(num(e.get("fog_end_distance")));
                let maxo = num(e.get("cubemapfogmaxopacity")).or(num(e.get("fogmaxopacity"))).or(num(e.get("fog_max_opacity")));
                let col = nums::<3>(e.get("fogcolor").or(e.get("fog_color")).or(e.get("cubemapfogcolor")), [-1.0; 3]);
                fog = json!({ "class": class, "start": start, "end": end, "maxOpacity": maxo, "color": if col[0] >= 0.0 { json!([col[0]/255.0, col[1]/255.0, col[2]/255.0]) } else { serde_json::Value::Null } });
            }
            _ => {}
        }
        if raw.len() < 64 && !class.starts_with("info_player") {
            let o: serde_json::Map<String, serde_json::Value> = match e.as_object() {
                Some(obj) => obj
                    .iter()
                    .filter(|(k, _)| !k.starts_with("hammer"))
                    .map(|(k, v)| (k.to_string(), match v {
                        Value::String(x) => json!(x),
                        Value::Float(f) => json!(f),
                        Value::Int(i) => json!(i),
                        Value::UInt(u) => json!(u),
                        Value::Bool(b) => json!(b),
                        Value::Array(a) => json!(a.iter().map(|x| x.as_f64().map(|f| json!(f)).unwrap_or_else(|| json!(x.as_str()))).collect::<Vec<_>>()),
                        _ => serde_json::Value::Null,
                    }))
                    .collect(),
                None => Default::default(),
            };
            raw.push(serde_json::Value::Object(o));
        }
    }
    json!({ "sun": sun, "sky": sky, "fog": fog, "spawnsT": spawns_t, "spawnsCT": spawns_ct, "entities": raw })
}

// ---------------------------------------------------------------- the export

pub fn export_map(game: &Game, map: &str, opts: &ExportOptions, progress: Progress) -> Result<Exported, Error> {
    let t0 = Instant::now();
    let mut stats = ExportStats::default();
    progress("Harita paketi açılıyor", 0.01);
    let vpk = game.open_map(map)?;
    let files = Files { game, map: &vpk };
    progress("Dünya düğümleri okunuyor", 0.03);
    let col = collect(&files, map, opts, &mut stats)?;
    if col.insts.is_empty() {
        return Err(Error::Parse(format!("{map}: haritada çizilecek nesne bulunamadı")));
    }

    // ---- models (parallel)
    let mut model_paths: Vec<&str> = col.insts.iter().map(|i| i.model.as_str()).collect();
    model_paths.sort_unstable();
    model_paths.dedup();
    let done = AtomicUsize::new(0);
    let total = model_paths.len().max(1);
    let models: HashMap<&str, ModelGeom> = model_paths
        .par_iter()
        .filter_map(|p| {
            let g = load_model(&files, p);
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            if d.is_multiple_of(32) || d == total {
                progress("Modeller okunuyor", 0.05 + 0.35 * d as f32 / total as f32);
            }
            g.map(|g| (*p, g))
        })
        .collect();
    stats.models = models.len();
    stats.models_missing = model_paths.len() - models.len();
    if stats.models_missing > 0 {
        let missing: Vec<&&str> = model_paths.iter().filter(|p| !models.contains_key(**p)).take(8).collect();
        stats.warnings.push(format!("{} model okunamadı (ör. {:?})", stats.models_missing, missing));
    }

    // ---- materials (parallel)
    let mut mat_paths: HashSet<&str> = HashSet::new();
    for inst in &col.insts {
        if let Some(m) = models.get(inst.model.as_str()) {
            for p in &m.prims {
                mat_paths.insert(prim_material(inst, p, &m.groups));
            }
        }
    }
    let mat_paths: Vec<&str> = mat_paths.into_iter().collect();
    progress("Malzemeler okunuyor", 0.42);
    let mats: HashMap<&str, MatInfo> = mat_paths
        .par_iter()
        .map(|p| {
            let info = match files.read(p) {
                Some(b) => material::interpret(p, &b),
                None => MatInfo::missing(p),
            };
            (*p, info)
        })
        .collect();
    let mut shader_count: HashMap<String, usize> = HashMap::new();
    for m in mats.values() {
        *shader_count.entry(if m.shader.is_empty() { "(yok)".into() } else { m.shader.clone() }).or_default() += 1;
    }
    let mut sc: Vec<(String, usize)> = shader_count.into_iter().collect();
    sc.sort_by_key(|x| std::cmp::Reverse(x.1));
    stats.shaders = sc;
    stats.materials_skipped = mats.values().filter(|m| m.skip).count();

    // ---- textures (parallel)
    let q = opts.quality;
    let mut tex_jobs: HashMap<(String, bool), usize> = HashMap::new();
    for m in mats.values() {
        if m.skip {
            continue;
        }
        if let Some(c) = &m.color {
            let n = tex_jobs.len();
            tex_jobs.entry((c.clone(), m.alpha != AlphaMode::Opaque)).or_insert(n);
        }
    }
    let mut jobs: Vec<((String, bool), usize)> = tex_jobs.into_iter().collect();
    jobs.sort_by_key(|j| j.1);
    let done = AtomicUsize::new(0);
    let total = jobs.len().max(1);
    let encoded: Vec<Option<texture::EncodedTexture>> = jobs
        .par_iter()
        .map(|((path, alpha), _)| {
            let r = files.read(path).and_then(|b| Texture::parse(&b).ok()).and_then(|t| texture::encode(&t, q.max_texture(), *alpha, opts.textures, 82).ok());
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            if d.is_multiple_of(8) || d == total {
                progress("Dokular dönüştürülüyor", 0.45 + 0.35 * d as f32 / total as f32);
            }
            r
        })
        .collect();
    let tex_index: HashMap<(String, bool), usize> = jobs.iter().map(|(k, i)| (k.clone(), *i)).collect();

    // ---- batches
    progress("Geometri birleştiriliyor", 0.82);
    let cell = q.cell_size();
    let mut mat_order: Vec<&str> = mats.iter().filter(|(_, m)| !m.skip).map(|(k, _)| *k).collect();
    mat_order.sort_unstable();
    let mat_id: HashMap<&str, usize> = mat_order.iter().enumerate().map(|(i, m)| (*m, i)).collect();
    let mut batches: HashMap<(usize, i32, i32), Batch> = HashMap::new();
    for inst in &col.insts {
        let Some(m) = models.get(inst.model.as_str()) else { continue };
        for p in &m.prims {
            if let Some(dc) = inst.draw_call {
                if p.mesh != 0 || p.dc != dc {
                    continue;
                }
            }
            let mp = prim_material(inst, p, &m.groups);
            let Some(&mi) = mat_id.get(mp) else { continue };
            let c = p.center;
            let w = [
                inst.xf[0][0] * c[0] + inst.xf[0][1] * c[1] + inst.xf[0][2] * c[2] + inst.xf[0][3],
                inst.xf[1][0] * c[0] + inst.xf[1][1] * c[1] + inst.xf[1][2] * c[2] + inst.xf[1][3],
            ];
            let key = (mi, (w[0] / cell).floor() as i32, (w[1] / cell).floor() as i32);
            let b = batches.entry(key).or_default();
            append(b, p, &inst.xf, inst.tint);
        }
    }

    // ---- write glb
    progress("Sahne yazılıyor", 0.9);
    let mut g = GlbBuilder::new();
    g.use_extension("KHR_mesh_quantization", true);
    if opts.textures == TexFormat::Ktx2 {
        g.use_extension("KHR_texture_basisu", true);
    }
    g.samplers.push(json!({ "magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497 }));
    let mut image_of_job: Vec<Option<usize>> = vec![None; encoded.len()];
    for (i, e) in encoded.iter().enumerate() {
        match e {
            Some(e) => {
                let img = g.image(&e.bytes, e.mime);
                let tex = if e.mime == "image/ktx2" { json!({ "sampler": 0, "extensions": { "KHR_texture_basisu": { "source": img } } }) } else { json!({ "sampler": 0, "source": img }) };
                g.textures.push(tex);
                image_of_job[i] = Some(g.textures.len() - 1);
                stats.textures += 1;
                stats.texture_gpu_bytes += e.gpu_bytes;
                stats.texture_file_bytes += e.bytes.len();
            }
            None => stats.textures_failed += 1,
        }
    }
    for path in &mat_order {
        let m = &mats[path];
        let tex = m.color.as_ref().and_then(|c| tex_index.get(&(c.clone(), m.alpha != AlphaMode::Opaque))).and_then(|&j| image_of_job[j]);
        let mut pbr = json!({ "baseColorFactor": m.tint, "metallicFactor": m.metalness, "roughnessFactor": m.roughness });
        if let Some(t) = tex {
            pbr["baseColorTexture"] = json!({ "index": t });
        } else if m.color.is_some() {
            // texture missing: neutral grey instead of pure white
            pbr["baseColorFactor"] = json!([m.tint[0] * 0.5, m.tint[1] * 0.5, m.tint[2] * 0.5, m.tint[3]]);
        }
        let mut mat = json!({
            "name": path.rsplit('/').next().unwrap_or(path),
            "pbrMetallicRoughness": pbr,
            "doubleSided": m.double_sided,
            "extras": { "path": path, "shader": m.shader, "overlay": m.overlay, "additive": m.additive, "kind": m.kind },
        });
        match m.alpha {
            AlphaMode::Opaque => {}
            AlphaMode::Mask => {
                mat["alphaMode"] = json!("MASK");
                mat["alphaCutoff"] = json!(m.alpha_cutoff);
            }
            AlphaMode::Blend => mat["alphaMode"] = json!("BLEND"),
        }
        g.materials.push(mat);
    }
    stats.materials = mat_order.len();

    let mut keys: Vec<(usize, i32, i32)> = batches.keys().copied().collect();
    keys.sort_unstable();
    let mut scene_min = [f32::MAX; 3];
    let mut scene_max = [f32::MIN; 3];
    for key in keys {
        let b = &batches[&key];
        if b.idx.is_empty() {
            continue;
        }
        let n = b.verts();
        for k in 0..3 {
            scene_min[k] = scene_min[k].min(b.min[k]);
            scene_max[k] = scene_max[k].max(b.max[k]);
        }
        let pv = g.view(&bytemuck_f32(&b.pos), Some(glb::ARRAY_BUFFER), None);
        let pa = g.accessor(pv, glb::FLOAT, n, "VEC3", false, Some(json!(b.min)), Some(json!(b.max)));
        let nv = g.view(&bytemuck_i8(&b.nrm), Some(glb::ARRAY_BUFFER), Some(4));
        let na = g.accessor(nv, glb::BYTE, n, "VEC3", true, None, None);
        let uvv = g.view(&bytemuck_f32(&b.uv), Some(glb::ARRAY_BUFFER), None);
        let ua = g.accessor(uvv, glb::FLOAT, n, "VEC2", false, None, None);
        let cv = g.view(&b.col, Some(glb::ARRAY_BUFFER), None);
        let ca = g.accessor(cv, glb::UNSIGNED_BYTE, n, "VEC4", true, None, None);
        let ia = if n <= 65535 {
            let v: Vec<u16> = b.idx.iter().map(|&i| i as u16).collect();
            let iv = g.view(&v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), Some(glb::ELEMENT_ARRAY_BUFFER), None);
            g.accessor(iv, glb::UNSIGNED_SHORT, b.idx.len(), "SCALAR", false, None, None)
        } else {
            let iv = g.view(&b.idx.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), Some(glb::ELEMENT_ARRAY_BUFFER), None);
            g.accessor(iv, glb::UNSIGNED_INT, b.idx.len(), "SCALAR", false, None, None)
        };
        g.meshes.push(json!({ "primitives": [ { "attributes": { "POSITION": pa, "NORMAL": na, "TEXCOORD_0": ua, "COLOR_0": ca }, "indices": ia, "material": key.0 } ] }));
        g.nodes.push(json!({ "mesh": g.meshes.len() - 1, "name": format!("b{}_{}_{}", key.0, key.1, key.2) }));
        stats.batches += 1;
        stats.vertices += n;
        stats.triangles += b.idx.len() / 3;
    }
    if stats.batches == 0 {
        return Err(Error::Parse(format!("{map}: çizilebilir geometri üretilemedi")));
    }
    stats.millis = t0.elapsed().as_millis() as u64;
    let mut env = env_extras(&col.entities);
    env["map"] = json!(map);
    env["rev"] = json!(EXPORT_REV);
    env["quality"] = json!(q.as_str());
    env["units"] = json!("source");
    env["coords"] = json!("three = (x, z, -y)");
    env["bounds"] = json!({ "min": scene_min, "max": scene_max });
    env["worldBounds"] = match col.bounds {
        Some((a, b)) => json!({ "min": a, "max": b }),
        None => serde_json::Value::Null,
    };
    let mut st = serde_json::to_value(&stats).unwrap_or_default();
    if let Some(o) = st.as_object_mut() {
        o.remove("warnings");
    }
    env["stats"] = st;
    let mut out = g.finish(json!({ "rewind": env }), "Rewind map exporter");
    // stats.glb_bytes is only known after writing; patch nothing in the file, report it outside
    stats.glb_bytes = out.len();
    out.shrink_to_fit();
    progress("Hazır", 1.0);
    Ok(Exported { glb: out, stats })
}

fn bytemuck_f32(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}
fn bytemuck_i8(v: &[i8]) -> Vec<u8> {
    v.iter().map(|&x| x as u8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_angles_match_source_convention() {
        // yaw 90: forward (+x local) points to +y world
        let a = entity_affine([0.0; 3], [0.0, 90.0, 0.0], [1.0; 3]);
        assert!((a[1][0] - 1.0).abs() < 1e-5 && a[0][0].abs() < 1e-5);
        // pitch 90: forward points down
        let a = entity_affine([0.0; 3], [90.0, 0.0, 0.0], [1.0; 3]);
        assert!((a[2][0] + 1.0).abs() < 1e-5);
        // translation and scale
        let a = entity_affine([1.0, 2.0, 3.0], [0.0; 3], [2.0; 3]);
        assert_eq!(a[0], [2.0, 0.0, 0.0, 1.0]);
        assert_eq!(a[2][3], 3.0);
    }

    #[test]
    fn three_mapping_is_a_rotation() {
        assert_eq!(to_three([1.0, 2.0, 3.0]), [1.0, 3.0, -2.0]);
        // heatel glTF frame (y, z, x)*s back to source
        let g = [2.0 * 0.0254, 3.0 * 0.0254, 1.0 * 0.0254];
        let s = from_gltf(g, true);
        assert!((s[0] - 1.0).abs() < 1e-4 && (s[1] - 2.0).abs() < 1e-4 && (s[2] - 3.0).abs() < 1e-4);
    }

    #[test]
    fn affine_compose_and_normals() {
        let a = entity_affine([10.0, 0.0, 0.0], [0.0, 90.0, 0.0], [1.0, 1.0, 1.0]);
        let b = mul(&a, &IDENTITY);
        assert_eq!(a, b);
        let m = [[2.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]];
        let n = normal_matrix(&m);
        // inverse-transpose * det: x scaled down relative to y/z
        assert!(n[0][0] < n[1][1]);
        let mirror = [[-1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]];
        assert!(det3(&mirror) < 0.0);
    }

    #[test]
    fn parses_affines_in_both_layouts() {
        let rows = Value::Array(vec![
            Value::Array(vec![Value::Float(1.0), Value::Float(0.0), Value::Float(0.0), Value::Float(5.0)]),
            Value::Array(vec![Value::Float(0.0), Value::Float(1.0), Value::Float(0.0), Value::Float(6.0)]),
            Value::Array(vec![Value::Float(0.0), Value::Float(0.0), Value::Float(1.0), Value::Float(7.0)]),
        ]);
        assert_eq!(affine(Some(&rows)).unwrap()[1][3], 6.0);
        let flat = Value::Array((0..12).map(|i| Value::Float(i as f64)).collect());
        assert_eq!(affine(Some(&flat)).unwrap()[2][0], 8.0);
        assert!(affine(Some(&Value::Array(vec![Value::Float(1.0)]))).is_none());
        assert_eq!(nums::<3>(Some(&Value::String("1 2 3".into())), [0.0; 3]), [1.0, 2.0, 3.0]);
        assert_eq!(nums::<3>(Some(&Value::String("bad".into())), [9.0; 3]), [9.0; 3]);
    }
}
