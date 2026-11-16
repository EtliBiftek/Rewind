//! Rewind in the browser. Runs inside a Web Worker (it reads the user's CS2 files synchronously
//! with `FileReaderSync`, which only workers have): parses `.dem` files and converts maps, agents,
//! weapons and animations from the CS2 folder the user picked, the same way the desktop app does.
//! Nothing leaves the user's computer.

use rewind_assets::heatel::{Slice, SliceSource};
use rewind_assets::{actors, ExportOptions, Game, Quality, TexFormat};
use wasm_bindgen::prelude::*;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// A JS progress callback `(stage, pct)`, callable from the export's `Sync` closures.
struct Progress<'a>(&'a js_sys::Function);
// shortcut: wasm32 without the atomics feature is single-threaded, so nothing is shared across threads.
unsafe impl Sync for Progress<'_> {}
impl Progress<'_> {
    fn call(&self, stage: &str, pct: f32) {
        let _ = self.0.call2(&JsValue::NULL, &JsValue::from_str(stage), &JsValue::from_f64(pct as f64));
    }
}

/// A demo parsed in the browser: its data (the JSON the desktop app's `load_demo` returns), the
/// frame store and the voice decoder.
#[wasm_bindgen]
pub struct WebDemo {
    inner: rewind_core::LoadedDemo,
}

#[wasm_bindgen]
impl WebDemo {
    /// `DemoData` as JSON.
    pub fn data_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.inner.data).map_err(err)
    }
    pub fn frames(&self) -> Vec<u8> {
        self.inner.frames_bytes()
    }
    /// Decoded voice of a player (empty when none).
    pub fn voice_pcm(&self, steam_id: &str) -> Vec<u8> {
        self.inner.voice_pcm_bytes(steam_id).unwrap_or_default()
    }
}

/// Parses a `.dem`. `progress(stageLabel, pct)` reports progress (Turkish labels).
#[wasm_bindgen]
pub fn load_demo(bytes: &[u8], file_name: &str, progress: &js_sys::Function) -> Result<WebDemo, JsError> {
    let p = Progress(progress);
    let cb = |stage: &str, pct: f32| p.call(rewind_core::stage_label(stage), pct.clamp(0.0, 1.0));
    let inner = rewind_core::load_bytes(bytes, file_name, &rewind_core::LoadOptions::default(), &cb).map_err(|e| err(format!("Demo yüklenemedi: {e}")))?;
    Ok(WebDemo { inner })
}

/// One of the user's files, read in slices.
struct WebFile(web_sys::File);
// shortcut: as for Progress; the export's rayon calls run on this one thread in the browser.
unsafe impl Send for WebFile {}
unsafe impl Sync for WebFile {}

impl Slice for WebFile {
    fn size(&self) -> u64 {
        self.0.size() as u64
    }
    fn read_at(&self, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
        let io = |e: JsValue| std::io::Error::other(format!("{e:?}"));
        let blob = self.0.slice_with_f64_and_f64(offset as f64, (offset + len as u64) as f64).map_err(io)?;
        let ab = web_sys::FileReaderSync::new().map_err(io)?.read_as_array_buffer(&blob).map_err(io)?;
        let out = js_sys::Uint8Array::new(&ab).to_vec();
        if out.len() != len {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }
        Ok(out)
    }
}

/// The CS2 install the user picked: `paths` relative to `game/csgo` (`pak01_dir.vpk`,
/// `pak01_000.vpk`, `maps/de_mirage.vpk`, ...) and their `File`s.
#[wasm_bindgen]
pub struct WebGame {
    game: Game,
    maps: Vec<String>,
}

#[wasm_bindgen]
impl WebGame {
    #[wasm_bindgen(constructor)]
    pub fn new(paths: Vec<String>, files: Vec<web_sys::File>) -> Result<WebGame, JsError> {
        if paths.len() != files.len() {
            return Err(err("dosya listesi uyuşmuyor"));
        }
        let mut src = SliceSource::default();
        let mut maps = Vec::new();
        for (p, f) in paths.into_iter().zip(files) {
            if let Some(m) = p.strip_prefix("maps/").and_then(|n| n.strip_suffix(".vpk")) {
                if rewind_assets::game::valid_map_name(m) && !m.ends_with("_vanity") && !m.ends_with("_preview") {
                    maps.push(m.to_string());
                }
            }
            src.insert(p, WebFile(f));
        }
        maps.sort();
        let game = Game::from_source(Box::new(src)).map_err(err)?;
        if game.pak01.is_none() {
            return Err(err(rewind_assets::Error::NotCs2(Default::default())));
        }
        Ok(WebGame { game, maps })
    }

    pub fn maps(&self) -> Vec<String> {
        self.maps.clone()
    }

    /// The map as binary glTF (same as the desktop app's `get_map_scene`).
    pub fn export_map(&self, map: &str, quality: &str, textures: &str, progress: &js_sys::Function) -> Result<Vec<u8>, JsError> {
        let p = Progress(progress);
        let cb = |stage: &str, pct: f32| p.call(stage, pct);
        let opts = ExportOptions { quality: Quality::parse(quality).unwrap_or(Quality::Medium), textures: tex(textures), entity_props: true };
        let ex = rewind_assets::export_map(&self.game, map, &opts, &cb).map_err(err)?;
        Ok(ex.glb)
    }

    /// The map exporter's revision (part of the page's cache key: a new exporter makes maps again).
    pub fn export_rev(&self) -> u32 {
        rewind_assets::export::EXPORT_REV
    }

    /// An agent / weapon model or animation resource (same as the desktop app's `get_actor_asset`).
    pub fn actor_asset(&self, path: &str, textures: &str) -> Result<Vec<u8>, JsError> {
        if !actors::allowed(path) {
            return Err(err(format!("İzin verilmeyen dosya: {path}")));
        }
        if path.ends_with(".vmdl") {
            actors::export_actor(&self.game, path, tex(textures), 1024).map_err(err)
        } else {
            actors::anim_json(&self.game, path).map_err(err)
        }
    }
}

fn tex(s: &str) -> TexFormat {
    if s == "image" {
        TexFormat::Image
    } else {
        TexFormat::Ktx2
    }
}
