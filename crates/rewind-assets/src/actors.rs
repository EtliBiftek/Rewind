//! Player agents, weapons and the game's own animation data from the user's CS2 install, for
//! the 3D replay: a model becomes a skinned binary glTF in Source space (inches, Z up; bones
//! named as in the game), an animation resource (`.vnmclip` / `.vnmskel`) its KV3 data as JSON
//! (decoded by the frontend).

use crate::glb::{self, GlbBuilder};
use crate::material::{self, AlphaMode, MatInfo};
use crate::texture::{self, TexFormat};
use crate::{Error, Game};
use heatel::{Model, Resource, Texture};
use serde_json::json;
use std::collections::HashMap;

/// Bump when the produced actor files change for the same input (invalidates caches).
pub const ACTOR_REV: u32 = 1;

/// Paths a caller may ask for: models of agents and weapons, animation resources. Anything else
/// is refused (the command takes the path from the web view).
pub fn allowed(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    let ok_chars = p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.' | '+'));
    let model = (p.starts_with("agents/models/") || p.starts_with("weapons/models/")) && p.ends_with(".vmdl");
    let anim = p.starts_with("animation/") && (p.ends_with(".vnmclip") || p.ends_with(".vnmskel"));
    ok_chars && !p.contains("..") && (model || anim)
}

impl Game {
    /// The bytes of a compiled file of the shared package (`path` with or without `_c`).
    pub fn read_shared(&self, path: &str) -> Option<Vec<u8>> {
        let mut p = path.replace('\\', "/");
        if !p.ends_with("_c") {
            p.push_str("_c");
        }
        let vpk = self.pak01.as_ref()?;
        for q in [p.clone(), p.to_ascii_lowercase()] {
            if vpk.get(&q).is_some() {
                if let Ok(b) = vpk.read_file(&self.src, &q) {
                    return Some(b);
                }
            }
        }
        None
    }
}

/// The DATA block of an animation resource as JSON.
pub fn anim_json(game: &Game, path: &str) -> Result<Vec<u8>, Error> {
    if !allowed(path) || path.ends_with(".vmdl") {
        return Err(Error::Parse(format!("izin verilmeyen dosya: {path}")));
    }
    let bytes = game.read_shared(path).ok_or_else(|| Error::Parse(format!("bulunamadı: {path}")))?;
    let res = Resource::parse(&bytes).map_err(|e| Error::Parse(format!("{path}: {e}")))?;
    let data = res.data().ok_or_else(|| Error::Parse(format!("{path}: veri yok")))?.map_err(|e| Error::Parse(format!("{path}: {e}")))?;
    serde_json::to_vec(&data).map_err(|e| Error::Parse(e.to_string()))
}

// ---------------------------------------------------------------- math (column vectors, row-major 4x4)

type M4 = [[f32; 4]; 4];

fn quat_mat(t: [f32; 3], q: [f32; 4]) -> M4 {
    let [x, y, z, w] = q;
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w), t[0]],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w), t[1]],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y), t[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn mul4(a: &M4, b: &M4) -> M4 {
    let mut r = [[0.0; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            r[i][j] = (0..4).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    r
}

/// Inverse of a rigid transform (rotation + translation).
fn inv_rigid(m: &M4) -> M4 {
    let mut r = [[0.0; 4]; 4];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = m[j][i];
        }
        r[i][3] = -(0..3).map(|k| m[k][i] * m[k][3]).sum::<f32>();
    }
    r[3][3] = 1.0;
    r
}

/// heatel's glTF frame (metres, `(y, z, x)` of Source) back to Source inches.
fn src_pos(g: [f32; 3]) -> [f32; 3] {
    let k = 1.0 / 0.0254;
    [g[2] * k, g[0] * k, g[1] * k]
}
fn src_dir(g: [f32; 3]) -> [f32; 3] {
    [g[2], g[0], g[1]]
}
fn src_quat(q: [f32; 4]) -> [f32; 4] {
    [q[2], q[0], q[1], q[3]]
}

// ---------------------------------------------------------------- export

/// Converts `path` (`agents/models/.../x.vmdl`, `weapons/models/.../x.vmdl`) to a skinned GLB.
pub fn export_actor(game: &Game, path: &str, tex: TexFormat, max_tex: u32) -> Result<Vec<u8>, Error> {
    if !allowed(path) || !path.ends_with(".vmdl") {
        return Err(Error::Parse(format!("izin verilmeyen model: {path}")));
    }
    let bytes = game.read_shared(path).ok_or_else(|| Error::Parse(format!("model bulunamadı: {path}")))?;
    let res = Resource::parse(&bytes).map_err(|e| Error::Parse(format!("{path}: {e}")))?;
    let model = Model::read(&res).map_err(|e| Error::Parse(format!("{path}: {e}")))?;

    let mut g = GlbBuilder::new();
    if tex == TexFormat::Ktx2 {
        g.use_extension("KHR_texture_basisu", true);
    }
    g.samplers.push(json!({ "magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497 }));

    // ---- skeleton: one node per bone, Source space
    let nb = model.bones.len();
    let mut world: Vec<M4> = Vec::with_capacity(nb);
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); nb];
    for (i, b) in model.bones.iter().enumerate() {
        let t = src_pos(b.translation);
        let q = src_quat(b.rotation);
        let local = quat_mat(t, q);
        let w = match b.parent {
            Some(p) if p < i => mul4(&world[p], &local),
            _ => local,
        };
        world.push(w);
        if let Some(p) = b.parent.filter(|&p| p < i) {
            children[p].push(i);
        }
        g.nodes.push(json!({ "name": b.name, "translation": t, "rotation": q }));
    }
    for (i, c) in children.iter().enumerate() {
        if !c.is_empty() {
            g.nodes[i]["children"] = json!(c);
        }
    }
    let mut roots: Vec<usize> = model.bones.iter().enumerate().filter(|(i, b)| b.parent.is_none_or(|p| p >= *i)).map(|(i, _)| i).collect();
    let skin = if nb > 0 {
        let ibm: Vec<f32> = world
            .iter()
            .flat_map(|w| {
                let m = inv_rigid(w);
                // glTF matrices are column-major
                (0..4).flat_map(move |c| (0..4).map(move |r| m[r][c])).collect::<Vec<f32>>()
            })
            .collect();
        let v = g.view(&f32b(&ibm), None, None);
        let a = g.accessor(v, glb::FLOAT, nb, "MAT4", false, None, None);
        g.skins.push(json!({ "joints": (0..nb).collect::<Vec<_>>(), "inverseBindMatrices": a, "skeleton": roots.first().copied().unwrap_or(0) }));
        Some(0)
    } else {
        None
    };

    // ---- materials and their colour textures
    let mut mat_ids: HashMap<String, usize> = HashMap::new();
    let mut tex_ids: HashMap<(String, bool), Option<usize>> = HashMap::new();
    let mut material_of = |g: &mut GlbBuilder, path: &str| -> Option<usize> {
        if let Some(&i) = mat_ids.get(path) {
            return Some(i);
        }
        let info = match game.read_shared(path) {
            Some(b) => material::interpret(path, &b),
            None => MatInfo::missing(path),
        };
        if info.skip {
            return None;
        }
        let alpha = info.alpha != AlphaMode::Opaque;
        let t = info.color.clone().and_then(|c| {
            *tex_ids.entry((c.clone(), alpha)).or_insert_with(|| {
                let e = game.read_shared(&c).and_then(|b| Texture::parse(&b).ok()).and_then(|t| texture::encode(&t, max_tex, alpha, tex, 88).ok())?;
                let img = g.image(&e.bytes, e.mime);
                let tx = if e.mime == "image/ktx2" { json!({ "sampler": 0, "extensions": { "KHR_texture_basisu": { "source": img } } }) } else { json!({ "sampler": 0, "source": img }) };
                g.textures.push(tx);
                Some(g.textures.len() - 1)
            })
        });
        let mut pbr = json!({ "baseColorFactor": info.tint, "metallicFactor": info.metalness, "roughnessFactor": info.roughness });
        if let Some(t) = t {
            pbr["baseColorTexture"] = json!({ "index": t });
        }
        let mut m = json!({ "name": path.rsplit('/').next().unwrap_or(path), "pbrMetallicRoughness": pbr, "doubleSided": info.double_sided, "extras": { "path": path, "shader": info.shader } });
        match info.alpha {
            AlphaMode::Opaque => {}
            AlphaMode::Mask => {
                m["alphaMode"] = json!("MASK");
                m["alphaCutoff"] = json!(info.alpha_cutoff);
            }
            AlphaMode::Blend => m["alphaMode"] = json!("BLEND"),
        }
        g.materials.push(m);
        mat_ids.insert(path.to_string(), g.materials.len() - 1);
        Some(g.materials.len() - 1)
    };

    // ---- meshes: one glTF mesh per model mesh, a primitive per draw call
    let mut tris = 0usize;
    for mesh in &model.meshes {
        let mut prims = Vec::new();
        let mut buf_acc: HashMap<usize, serde_json::Value> = HashMap::new();
        for p in &mesh.primitives {
            let Some(v) = mesh.vertices.get(p.vertices) else { continue };
            if v.positions.is_empty() || p.indices.len() < 3 {
                continue;
            }
            let Some(mat) = material_of(&mut g, &p.material) else { continue };
            let attrs = buf_acc
                .entry(p.vertices)
                .or_insert_with(|| {
                    let n = v.positions.len();
                    let pos: Vec<[f32; 3]> = v.positions.iter().map(|&q| src_pos(q)).collect();
                    let mut mn = [f32::MAX; 3];
                    let mut mx = [f32::MIN; 3];
                    for q in &pos {
                        for k in 0..3 {
                            mn[k] = mn[k].min(q[k]);
                            mx[k] = mx[k].max(q[k]);
                        }
                    }
                    let pv = g.view(&f32b(&pos.concat()), Some(glb::ARRAY_BUFFER), None);
                    let mut a = json!({ "POSITION": g.accessor(pv, glb::FLOAT, n, "VEC3", false, Some(json!(mn)), Some(json!(mx))) });
                    if let Some(nr) = &v.normals {
                        let nn: Vec<f32> = nr.iter().flat_map(|&q| src_dir(q)).collect();
                        let nv = g.view(&f32b(&nn), Some(glb::ARRAY_BUFFER), None);
                        a["NORMAL"] = json!(g.accessor(nv, glb::FLOAT, n, "VEC3", false, None, None));
                    }
                    if let Some(uv) = v.uvs.first() {
                        let uvv = g.view(&f32b(&uv.concat()), Some(glb::ARRAY_BUFFER), None);
                        a["TEXCOORD_0"] = json!(g.accessor(uvv, glb::FLOAT, n, "VEC2", false, None, None));
                    }
                    if let (Some(sk), Some(_)) = (&v.skin, skin) {
                        let j: Vec<u8> = sk.joints.iter().flat_map(|j| j.iter().flat_map(|x| x.min(&((nb.max(1) - 1) as u16)).to_le_bytes())).collect();
                        let jv = g.view(&j, Some(glb::ARRAY_BUFFER), None);
                        a["JOINTS_0"] = json!(g.accessor(jv, glb::UNSIGNED_SHORT, n, "VEC4", false, None, None));
                        let w: Vec<f32> = sk.weights.iter().flat_map(|w| {
                            let s = (w[0] + w[1] + w[2] + w[3]).max(1e-6);
                            [w[0] / s, w[1] / s, w[2] / s, w[3] / s]
                        }).collect();
                        let wv = g.view(&f32b(&w), Some(glb::ARRAY_BUFFER), None);
                        a["WEIGHTS_0"] = json!(g.accessor(wv, glb::FLOAT, n, "VEC4", false, None, None));
                    }
                    a
                })
                .clone();
            let iv = g.view(&p.indices.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), Some(glb::ELEMENT_ARRAY_BUFFER), None);
            let ia = g.accessor(iv, glb::UNSIGNED_INT, p.indices.len(), "SCALAR", false, None, None);
            tris += p.indices.len() / 3;
            prims.push(json!({ "attributes": attrs, "indices": ia, "material": mat }));
        }
        if prims.is_empty() {
            continue;
        }
        let skinned = prims.iter().all(|p| p["attributes"].get("JOINTS_0").is_some());
        g.meshes.push(json!({ "name": mesh.name, "primitives": prims }));
        let mut node = json!({ "name": mesh.name, "mesh": g.meshes.len() - 1 });
        if skinned {
            if let Some(s) = skin {
                node["skin"] = json!(s);
            }
        }
        g.nodes.push(node);
        roots.push(g.nodes.len() - 1);
    }
    if g.meshes.is_empty() {
        return Err(Error::Parse(format!("{path}: çizilebilir mesh yok")));
    }
    g.roots = Some(roots);
    let attachments: Vec<serde_json::Value> = model
        .attachments
        .iter()
        .map(|a| json!({ "name": a.name, "bone": a.bone.map(|b| model.bones[b].name.clone()), "translation": src_pos(a.translation), "rotation": src_quat(a.rotation) }))
        .collect();
    let extras = json!({ "rewindActor": { "path": path, "rev": ACTOR_REV, "units": "source", "triangles": tris, "attachments": attachments } });
    Ok(g.finish(extras, "Rewind actor exporter"))
}

fn f32b(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// Cached [`export_actor`] / [`anim_json`]: one file per path, format and size under `dir`,
/// keyed by the shared package's size and time.
pub fn get_or_export(game: &Game, dir: &std::path::Path, path: &str, tex: TexFormat, max_tex: u32) -> Result<Vec<u8>, Error> {
    let pak = game.csgo.join("pak01_dir.vpk");
    let (len, mt) = std::fs::metadata(&pak)
        .map(|m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)))
        .unwrap_or((0, 0));
    let is_model = path.ends_with(".vmdl");
    let fmt = if !is_model { "json" } else if tex == TexFormat::Ktx2 { "ktx2" } else { "img" };
    let safe: String = path.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' { c } else { '~' }).collect();
    let name = format!("{safe}.{fmt}.{max_tex}.{ACTOR_REV}.{len:x}{mt:x}");
    let file = dir.join(&name);
    if let Ok(b) = std::fs::read(&file) {
        if !b.is_empty() {
            return Ok(b);
        }
    }
    let out = if is_model { export_actor(game, path, tex, max_tex)? } else { anim_json(game, path)? };
    if std::fs::create_dir_all(dir).is_ok() {
        let tmp = dir.join(format!("{name}.tmp{}", std::process::id()));
        if std::fs::write(&tmp, &out).is_ok() && std::fs::rename(&tmp, &file).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowed_paths() {
        assert!(allowed("agents/models/ctm_sas/ctm_sas.vmdl"));
        assert!(allowed("weapons/models/ak47/weapon_rif_ak47.vmdl"));
        assert!(allowed("animation/anims/world/rifle/_default_rifle/run_n_rifle.vnmclip"));
        assert!(allowed("animation/skeletons/characters/worldmodel.vnmskel"));
        assert!(!allowed("agents/models/../../secret.vmdl"));
        assert!(!allowed("maps/de_dust2.vpk"));
        assert!(!allowed("materials/x.vmat"));
    }
    #[test]
    fn rigid_inverse() {
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let m = quat_mat([1.0, 2.0, 3.0], [0.0, 0.0, s, s]);
        let r = mul4(&m, &inv_rigid(&m));
        for i in 0..4 {
            for j in 0..4 {
                assert!((r[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-5);
            }
        }
    }
}
