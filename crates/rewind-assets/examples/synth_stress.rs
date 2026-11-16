//! Dev tool: writes a SYNTHETIC scene in the exporter's GLB layout with competitive-map-like
//! numbers (default ~1.2 M triangles, 350 materials, ~1000 batches, 250 BC1 textures of 512²)
//! to measure loading/rendering cost without game files. Contains no game content.
//!   synth_stress <out.glb> [triangles] [materials]
use rewind_assets::glb::{self, GlbBuilder};
use rewind_assets::heatel::texture::{Encoding, PixelFormat};
use rewind_assets::heatel::Texture;
use serde_json::json;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let out = a.get(1).expect("out.glb");
    let tris: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1_200_000);
    let nmat: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(350);
    let ntex = (nmat * 5 / 7).max(1);
    let mut g = GlbBuilder::new();
    g.use_extension("KHR_mesh_quantization", true);
    g.use_extension("KHR_texture_basisu", true);
    g.samplers.push(json!({ "magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497 }));
    for t in 0..ntex {
        let px: Vec<u8> = (0..512 * 512).flat_map(|i| {
            let (x, y) = (i % 512, i / 512);
            let c = (((x / 32) + (y / 32) + t) % 2) as u8;
            [90 + c * 80 + (t * 37 % 60) as u8, 80 + c * 60, 70 + (t * 13 % 90) as u8, 255]
        }).collect();
        let tex = Texture::from_rgba8(512, 512, px).unwrap().with_mips(Encoding::Srgb).compressed(PixelFormat::Bc1, Encoding::Srgb).unwrap();
        let img = g.image(&tex.to_ktx2(Encoding::Srgb), "image/ktx2");
        g.textures.push(json!({ "sampler": 0, "extensions": { "KHR_texture_basisu": { "source": img } } }));
    }
    for m in 0..nmat {
        g.materials.push(json!({ "pbrMetallicRoughness": { "baseColorTexture": { "index": m % ntex }, "metallicFactor": 0.0, "roughnessFactor": 0.85 }, "extras": { "kind": "default" } }));
    }
    // boxes (12 triangles) scattered over a 6000 x 6000 area, grouped into ~3 cells per material
    let boxes = tris / 12;
    let batches = nmat * 3;
    let per = boxes / batches;
    let mut rng = 12345u64;
    let mut r = || { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; (rng % 100000) as f32 / 100000.0 };
    let mut total = 0;
    for b in 0..batches {
        let (cx, cz) = (-3000.0 + 6000.0 * ((b % 3) as f32 / 3.0) + r() * 2000.0, -3000.0 + r() * 6000.0);
        let (mut pos, mut nrm, mut uv, mut col, mut idx) = (vec![], vec![], vec![], vec![], vec![]);
        let (mut mn, mut mx) = ([f32::MAX; 3], [f32::MIN; 3]);
        for _ in 0..per {
            let (x, z, y) = (cx + r() * 1000.0, cz + r() * 1000.0, r() * 300.0);
            let (sx, sy, sz) = (8.0 + r() * 120.0, 8.0 + r() * 150.0, 8.0 + r() * 120.0);
            for (n, corners) in [
                ([1i8, 0, 0], [[1., 0., 0.], [1., 1., 0.], [1., 1., 1.], [1., 0., 1.]]),
                ([-1, 0, 0], [[0., 0., 1.], [0., 1., 1.], [0., 1., 0.], [0., 0., 0.]]),
                ([0, 1, 0], [[0., 1., 0.], [0., 1., 1.], [1., 1., 1.], [1., 1., 0.]]),
                ([0, -1, 0], [[0., 0., 1.], [0., 0., 0.], [1., 0., 0.], [1., 0., 1.]]),
                ([0, 0, 1], [[1., 0., 1.], [1., 1., 1.], [0., 1., 1.], [0., 0., 1.]]),
                ([0, 0, -1], [[0., 0., 0.], [0., 1., 0.], [1., 1., 0.], [1., 0., 0.]]),
            ] {
                let base = (pos.len() / 3) as u32;
                for (k, c) in corners.iter().enumerate() {
                    let p = [x + c[0] * sx, y + c[1] * sy, z + c[2] * sz];
                    for i in 0..3 { mn[i] = mn[i].min(p[i]); mx[i] = mx[i].max(p[i]); }
                    pos.extend_from_slice(&p);
                    nrm.extend_from_slice(&[n[0] * 127, n[1] * 127, n[2] * 127, 0]);
                    uv.extend_from_slice(&[[0., 1., 1., 0.][k] * sx / 128.0, [0., 0., 1., 1.][k] * sy / 128.0]);
                    col.extend_from_slice(&[255u8, 255, 255, 255]);
                }
                idx.extend_from_slice(&[base, base + 2, base + 1, base, base + 3, base + 2]);
            }
        }
        total += idx.len() / 3;
        let n = pos.len() / 3;
        let f = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
        let pv = g.view(&f(&pos), Some(glb::ARRAY_BUFFER), None);
        let pa = g.accessor(pv, glb::FLOAT, n, "VEC3", false, Some(json!(mn)), Some(json!(mx)));
        let nv = g.view(&nrm.iter().map(|&x| x as u8).collect::<Vec<u8>>(), Some(glb::ARRAY_BUFFER), Some(4));
        let na = g.accessor(nv, glb::BYTE, n, "VEC3", true, None, None);
        let uvv = g.view(&f(&uv), Some(glb::ARRAY_BUFFER), None);
        let ua = g.accessor(uvv, glb::FLOAT, n, "VEC2", false, None, None);
        let cv = g.view(&col, Some(glb::ARRAY_BUFFER), None);
        let ca = g.accessor(cv, glb::UNSIGNED_BYTE, n, "VEC4", true, None, None);
        let iv = g.view(&idx.iter().flat_map(|x| (*x as u16).to_le_bytes()).collect::<Vec<u8>>(), Some(glb::ELEMENT_ARRAY_BUFFER), None);
        let ia = g.accessor(iv, glb::UNSIGNED_SHORT, idx.len(), "SCALAR", false, None, None);
        g.meshes.push(json!({ "primitives": [ { "attributes": { "POSITION": pa, "NORMAL": na, "TEXCOORD_0": ua, "COLOR_0": ca }, "indices": ia, "material": b % nmat } ] }));
        g.nodes.push(json!({ "mesh": g.meshes.len() - 1 }));
    }
    let extras = json!({ "rewind": { "map": "synthetic", "rev": 0, "quality": "medium", "units": "source",
        "bounds": { "min": [-3000, 0, -3000], "max": [4000, 450, 4000] }, "worldBounds": null,
        "sun": { "toSun": [0.4, 0.8, 0.45], "color": [1, 0.95, 0.85], "brightness": 1.2, "ambient": null },
        "sky": null, "fog": null, "spawnsT": [], "spawnsCT": [], "stats": { "textureGpuBytes": ntex * 174_776, "synthetic": true } } });
    let bytes = g.finish(extras, "Rewind synthetic stress scene");
    std::fs::write(out, &bytes).unwrap();
    eprintln!("synthetic: {total} triangles, {batches} batches, {nmat} materials, {ntex} textures, {} MB", bytes.len() / 1048576);
}
