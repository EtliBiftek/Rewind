//! On-disk cache of exported map scenes, keyed by map, quality, texture format, exporter
//! revision and the size + modification time of the packages they were made from.

use crate::export::{export_map, ExportOptions, EXPORT_REV, Progress};
use crate::game::Game;
use crate::{Error, TexFormat};
use std::path::{Path, PathBuf};

fn fnv(data: &[u8], mut h: u64) -> u64 {
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Cache key of a map export (hex), from the files' identity rather than content (fast).
pub fn key(game: &Game, map: &str, opts: &ExportOptions) -> String {
    let mut h = 0xcbf29ce484222325u64;
    h = fnv(map.as_bytes(), h);
    h = fnv(opts.quality.as_str().as_bytes(), h);
    h = fnv(if opts.textures == TexFormat::Ktx2 { b"ktx2" } else { b"img" }, h);
    h = fnv(&EXPORT_REV.to_le_bytes(), h);
    h = fnv(&[opts.entity_props as u8], h);
    for f in game.fingerprint_files(map) {
        if let Ok(m) = std::fs::metadata(&f) {
            h = fnv(&m.len().to_le_bytes(), h);
            let mt = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            h = fnv(&mt.to_le_bytes(), h);
        }
    }
    format!("{h:016x}")
}

pub fn file_name(map: &str, opts: &ExportOptions, key: &str) -> String {
    let fmt = if opts.textures == TexFormat::Ktx2 { "ktx2" } else { "img" };
    format!("{map}.{}.{fmt}.{key}.glb", opts.quality.as_str())
}

pub struct CachedScene {
    pub glb: Vec<u8>,
    pub path: PathBuf,
    pub from_cache: bool,
    pub stats: Option<crate::ExportStats>,
}

/// Returns the cached scene or exports and stores it. Older cache files of the same
/// map/quality/format are removed.
pub fn get_or_export(game: &Game, cache_dir: &Path, map: &str, opts: &ExportOptions, progress: Progress) -> Result<CachedScene, Error> {
    let key = key(game, map, opts);
    let name = file_name(map, opts, &key);
    let path = cache_dir.join(&name);
    if let Ok(glb) = std::fs::read(&path) {
        if glb.len() > 20 && &glb[0..4] == b"glTF" {
            progress("Önbellekten yüklendi", 1.0);
            return Ok(CachedScene { glb, path, from_cache: true, stats: None });
        }
    }
    let ex = export_map(game, map, opts, progress)?;
    if std::fs::create_dir_all(cache_dir).is_ok() {
        let prefix = file_name(map, opts, "");
        if let Ok(rd) = std::fs::read_dir(cache_dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with(prefix.trim_end_matches(".glb")) && n != name {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let tmp = cache_dir.join(format!("{name}.tmp{}", std::process::id()));
        if std::fs::write(&tmp, &ex.glb).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    Ok(CachedScene { glb: ex.glb, path, from_cache: false, stats: Some(ex.stats) })
}
