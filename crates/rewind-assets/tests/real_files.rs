//! Tests against real compiled Source 2 files. They are never committed: the ValveResourceFormat
//! test corpus is expected under `testdata/vrf/` (copy of `Tests/Files` of
//! github.com/ValveResourceFormat/ValveResourceFormat) and a CS2 install under `testdata/cs2/`
//! (or `REWIND_CS2_PATH`). Each test is skipped when its data is absent.

use rewind_assets::export::{export_map, ExportOptions};
use rewind_assets::heatel::{DirSource, Model, Resource, Texture, Vpk};
use rewind_assets::{glb, Game, Quality, TexFormat};
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn vrf() -> Option<PathBuf> {
    let p = root().join("testdata/vrf");
    p.join("small_map_with_material.vpk").is_file().then_some(p)
}
macro_rules! need {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => {
                eprintln!("skipped: test data not present");
                return;
            }
        }
    };
}

fn decode_png(bytes: &[u8]) -> (u32, u32, Vec<u8>) {
    let mut d = png::Decoder::new(std::io::Cursor::new(bytes));
    d.set_transformations(png::Transformations::normalize_to_color8());
    let mut r = d.read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size().unwrap()];
    let info = r.next_frame(&mut buf).unwrap();
    buf.truncate(info.buffer_size());
    let px = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        _ => panic!("indexed"),
    };
    (info.width, info.height, px)
}

#[test]
fn vpk_v2_directory_and_crc_checked_reads() {
    let dir = need!(vrf());
    let src = DirSource::new(&dir);
    let vpk = Vpk::open(&src, "small_map_with_material.vpk").unwrap();
    assert_eq!(vpk.len(), 12);
    let mut total = 0;
    for e in vpk.entries() {
        let bytes = vpk.read(&src, e).unwrap();
        assert_eq!(bytes.len() as u64, e.size());
        total += bytes.len();
    }
    assert!(total > 20000);
    assert!(vpk.get("maps/ui/nametag/world.vwrld_c").is_some());
    assert!(vpk.get("maps\\ui\\nametag\\world.vwrld_c").is_some(), "backslash paths");
    // every packaged test VPK opens
    for f in ["dota_riverflow_fx.vpk", "entity_io_param_map_test.vpk", "point_template_test.vpk", "play_searching.vpk"] {
        let v = Vpk::open(&src, f).unwrap();
        for e in v.entries() {
            v.read(&src, e).unwrap();
        }
    }
}

#[test]
fn kv3_every_version_and_compression() {
    let dir = need!(vrf());
    let mut n = 0;
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let typed = [".vmdl_c", ".vmat_c", ".vents_c", ".vwnod_c", ".vdata_c", ".vpost_c", ".vpcf_c", ".vanmgrph_c"].iter().any(|e| name.ends_with(e));
        if !name.contains("kv3") || !typed || name.contains("kv3_text") {
            continue;
        }
        let bytes = std::fs::read(e.path()).unwrap();
        let r = Resource::parse(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        let d = r.data().unwrap_or_else(|| panic!("{name}: no data")).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(d.as_object().is_some_and(|o| !o.is_empty()), "{name}");
        n += 1;
    }
    assert!(n >= 15, "kv3 files tested: {n}");
}

#[test]
fn textures_match_reference_pngs() {
    let dir = need!(vrf()).join("Textures");
    let mut compared = 0;
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".vtex_c") else { continue };
        let png_path = dir.join(format!("{stem}.png"));
        if !png_path.is_file() {
            continue;
        }
        let tex = match Texture::parse(&std::fs::read(e.path()).unwrap()) {
            Ok(t) => t,
            Err(err) => {
                eprintln!("  {name}: not decodable ({err})");
                continue;
            }
        };
        let (w, h, want) = decode_png(&std::fs::read(&png_path).unwrap());
        if (w, h) != (tex.width(), tex.height()) {
            eprintln!("  {name}: reference {w}x{h} vs {}x{}", tex.width(), tex.height());
            continue;
        }
        let got = tex.level_rgba8(0).unwrap();
        // one-channel formats: VRF writes grey, compare red only; skip fully transparent texels
        let channels: &[usize] = if matches!(tex.format(), rewind_assets::heatel::texture::PixelFormat::Bc4) { &[0] } else { &[0, 1, 2] };
        let (mut sum, mut n) = (0f64, 0usize);
        for (g, r) in got.chunks_exact(4).zip(want.chunks_exact(4)) {
            if r[3] == 0 {
                continue;
            }
            for &c in channels {
                sum += (g[c] as f64 - r[c] as f64).abs();
                n += 1;
            }
        }
        let diff = sum / n.max(1) as f64;
        eprintln!("  {name}: {w}x{h} {:?} mean abs diff {diff:.2}", tex.format());
        // RGBA8888_red_large_on_png: the corpus PNG has red/blue swapped relative to the file
        // bytes (the texture is a red button: the file's order is right)
        if !name.contains("normal") && !name.contains("ATI") && !name.starts_with("RGBA8888_red") {
            assert!(diff < 3.0, "{name}: mean abs diff {diff}");
        }
        compared += 1;
    }
    assert!(compared >= 6, "compared {compared}");
}

#[test]
fn cs2_texture_formats_decode() {
    let dir = need!(vrf()).join("Textures");
    for f in ["BC7_testgrid_color_tga_2d6cc34.vtex_c", "ATI2N_hotel_tarp_001_freedom_psd_993397bd.vtex_c", "sheet_clamp_decal.vtex_c", "sheet_alphacrop.vtex_c", "DXT5_lava_drops_sheet.vtex_c"] {
        let t = Texture::parse(&std::fs::read(dir.join(f)).unwrap()).unwrap_or_else(|e| panic!("{f}: {e}"));
        for l in 0..t.mips().len() {
            t.level_rgba8(l).unwrap();
        }
        for fmt in [TexFormat::Ktx2, TexFormat::Image] {
            let e = rewind_assets::texture::encode(&t, 256, true, fmt, 80).unwrap();
            assert!(e.width <= 256 && e.height <= 256 && !e.bytes.is_empty());
        }
    }
}

#[test]
fn cs2_models_with_meshopt_buffers() {
    let dir = need!(vrf());
    for (f, min_tris) in [("ctm_sas.vmdl_c", 5000), ("n0_lr0_agg_prop_plants001_0.vmdl_c", 10), ("n0_lr0_c0_s_cb_b_nomerge236.vmdl_c", 2), ("street_curb_corner_int_01.vmdl_c", 10), ("wooden_crate_01.vmdl_c", 6)] {
        let bytes = std::fs::read(dir.join(f)).unwrap();
        let m = Model::read(&Resource::parse(&bytes).unwrap()).unwrap_or_else(|e| panic!("{f}: {e}"));
        let mut tris = 0;
        for mesh in &m.meshes {
            for p in &mesh.primitives {
                let v = &mesh.vertices[p.vertices];
                assert!(p.indices.iter().all(|&i| (i as usize) < v.positions.len()), "{f}: index range");
                assert!(v.positions.iter().flatten().all(|c| c.is_finite()), "{f}: finite");
                assert!(!p.material.is_empty(), "{f}: material");
                tris += p.indices.len() / 3;
            }
        }
        assert!(tris >= min_tris, "{f}: {tris} triangles");
    }
}

#[test]
fn entity_lumps_parse() {
    let dir = need!(vrf());
    // KV3 entity data (current CS2); the older binary key-value form is reported as an error
    for f in ["default_ents_kv3_v4_zstd.vents_c", "graphics_settings_ents.vents_c"] {
        let bytes = std::fs::read(dir.join(f)).unwrap();
        let l = rewind_assets::heatel::world::EntityLump::read(&Resource::parse(&bytes).unwrap()).unwrap();
        assert!(!l.entities.is_empty(), "{f}");
    }
}

/// A fake install whose only map is the real CS2 map package of the VRF corpus.
fn fake_install() -> Option<PathBuf> {
    let dir = vrf()?;
    let tmp = std::env::temp_dir().join(format!("rewind-fakecs2-{}", std::process::id()));
    let csgo = tmp.join("game/csgo");
    std::fs::create_dir_all(csgo.join("maps")).ok()?;
    std::fs::write(csgo.join("gameinfo.gi"), b"").ok()?;
    std::fs::copy(dir.join("small_map_with_material.vpk"), csgo.join("maps/nametag.vpk")).ok()?;
    Some(csgo)
}

#[test]
fn exports_a_real_cs2_map_package_to_glb() {
    let csgo = need!(fake_install());
    assert_eq!(rewind_assets::steam::resolve_user_path(csgo.parent().unwrap().parent().unwrap()).as_deref(), Some(csgo.as_path()));
    let maps = Game::list_maps(&csgo);
    assert_eq!(maps.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["nametag"]);
    let game = Game::open(&csgo).unwrap();
    for textures in [TexFormat::Ktx2, TexFormat::Image] {
        let opts = ExportOptions { quality: Quality::Medium, textures, entity_props: true };
        let ex = export_map(&game, "nametag", &opts, &|_, _| {}).unwrap();
        let (doc, bin) = glb::parse(&ex.glb).unwrap();
        assert_eq!(ex.stats.triangles, 2);
        assert_eq!(ex.stats.textures, 1);
        let env = &doc["scenes"][0]["extras"]["rewind"];
        // floor of the nametag map is at Source z = -15 -> three y = -15
        let ymin = env["bounds"]["min"][1].as_f64().unwrap();
        assert!((ymin + 15.0).abs() < 0.01, "floor height {ymin}");
        assert!(env["sun"]["toSun"][1].as_f64().unwrap() > 0.0, "sun above the horizon");
        // winding: geometric normal of the first triangle agrees with the stored vertex normal (up)
        let prim = &doc["meshes"][0]["primitives"][0];
        let acc = |i: &serde_json::Value| &doc["accessors"][i.as_u64().unwrap() as usize];
        let view = |a: &serde_json::Value| &doc["bufferViews"][a["bufferView"].as_u64().unwrap() as usize];
        let pa = acc(&prim["attributes"]["POSITION"]);
        let po = view(pa)["byteOffset"].as_u64().unwrap() as usize;
        let p = |i: usize, k: usize| f32::from_le_bytes(bin[po + i * 12 + k * 4..po + i * 12 + k * 4 + 4].try_into().unwrap());
        let ia = acc(&prim["indices"]);
        let io = view(ia)["byteOffset"].as_u64().unwrap() as usize;
        assert_eq!(ia["componentType"], 5123);
        let ix = |n: usize| u16::from_le_bytes(bin[io + n * 2..io + n * 2 + 2].try_into().unwrap()) as usize;
        let (a, b, c) = (ix(0), ix(1), ix(2));
        let e1 = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)];
        let e2 = [p(c, 0) - p(a, 0), p(c, 1) - p(a, 1), p(c, 2) - p(a, 2)];
        let ny = e1[2] * e2[0] - e1[0] * e2[2];
        assert!(ny > 0.0, "counter-clockwise seen from above (front face up): {ny}");
        let na = acc(&prim["attributes"]["NORMAL"]);
        let no = view(na)["byteOffset"].as_u64().unwrap() as usize;
        assert!((bin[no + 1] as i8) > 100, "stored normal points up");
        let mime = doc["images"][0]["mimeType"].as_str().unwrap();
        assert_eq!(mime, if textures == TexFormat::Ktx2 { "image/ktx2" } else { "image/jpeg" });
    }
    // cache: second call is served from disk
    let cache = std::env::temp_dir().join(format!("rewind-cache-test-{}", std::process::id()));
    let opts = ExportOptions::default();
    let a = rewind_assets::cache::get_or_export(&game, &cache, "nametag", &opts, &|_, _| {}).unwrap();
    let b = rewind_assets::cache::get_or_export(&game, &cache, "nametag", &opts, &|_, _| {}).unwrap();
    assert!(!a.from_cache && b.from_cache && a.glb == b.glb);
    assert!(matches!(game.open_map("de_nothing"), Err(rewind_assets::Error::MapNotFound(_))));
    let _ = std::fs::remove_dir_all(&cache);
    let _ = std::fs::remove_dir_all(csgo.parent().unwrap().parent().unwrap());
}

/// Truncated and bit-flipped versions of real files must give errors, never panics.
#[test]
fn corrupt_inputs_do_not_panic() {
    let dir = need!(vrf());
    let files = ["ctm_sas.vmdl_c", "node000_kv3_v2_zstd.vwnod_c", "player_start_kv3_v5.vmat_c", "default_ents_kv3_v4_zstd.vents_c", "Textures/BC7_testgrid_color_tga_2d6cc34.vtex_c", "Textures/sheet_clamp_decal.vtex_c", "n0_lr0_agg_prop_plants001_0.vmdl_c"];
    let mut rng = 0x2545F4914F6CDD1Du64;
    let mut next = || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng
    };
    for f in files {
        let orig = std::fs::read(dir.join(f)).unwrap();
        for round in 0..60 {
            let mut b = orig.clone();
            if round % 3 == 0 {
                b.truncate((next() as usize) % b.len());
            } else {
                for _ in 0..(1 + round % 7) {
                    let i = (next() as usize) % b.len();
                    b[i] ^= 1 << (next() % 8);
                }
            }
            if let Ok(r) = Resource::parse(&b) {
                let _ = r.data();
                let _ = Model::read(&r);
            }
            if let Ok(t) = Texture::parse(&b) {
                let _ = rewind_assets::texture::encode(&t, 128, true, TexFormat::Ktx2, 80);
            }
            let _ = rewind_assets::material::interpret("materials/x.vmat", &b);
        }
    }
    // corrupt VPK directory
    let vpk = std::fs::read(dir.join("small_map_with_material.vpk")).unwrap();
    let tmp = std::env::temp_dir().join(format!("rewind-badvpk-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    for round in 0..80 {
        let mut b = vpk.clone();
        if round % 2 == 0 {
            b.truncate((next() as usize) % 900);
        } else {
            let i = (next() as usize) % 800;
            b[i] ^= 0xff;
        }
        std::fs::write(tmp.join("x.vpk"), &b).unwrap();
        let src = DirSource::new(&tmp);
        if let Ok(v) = Vpk::open(&src, "x.vpk") {
            for e in v.entries() {
                let _ = v.read(&src, e);
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

/// A real CS2 install (never in the repository). Exports every map named in REWIND_TEST_MAPS
/// (default de_mirage) and checks basic sanity.
#[test]
fn real_cs2_install_maps() {
    let csgo = std::env::var_os("REWIND_CS2_PATH")
        .map(PathBuf::from)
        .or_else(|| Some(root().join("testdata/cs2")))
        .and_then(|p| rewind_assets::steam::resolve_user_path(&p));
    let csgo = need!(csgo);
    let game = Game::open(&csgo).unwrap();
    let maps = std::env::var("REWIND_TEST_MAPS").unwrap_or_else(|_| "de_mirage".into());
    for map in maps.split(',') {
        let ex = export_map(&game, map, &ExportOptions { quality: Quality::Low, ..Default::default() }, &|_, _| {}).unwrap();
        let st = &ex.stats;
        eprintln!("{map}: {st:?}");
        assert!(st.triangles > 100_000, "{map}: {} triangles", st.triangles);
        assert!(st.materials > 50 && st.textures > 50);
        assert!(st.models_missing * 20 < st.models, "few missing models");
    }
}
