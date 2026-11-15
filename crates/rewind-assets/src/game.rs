//! Read access to a CS2 install: `game/csgo/pak01_dir.vpk` (shared content) and the per-map
//! packages `game/csgo/maps/<map>.vpk`.

use crate::Error;
use heatel::{DirSource, Vpk};
use std::path::{Path, PathBuf};

/// The `game/csgo` folder of an install with its shared package opened.
pub struct Game {
    pub csgo: PathBuf,
    pub src: DirSource,
    /// `pak01_dir.vpk` (None when absent: maps that pack everything themselves still work).
    pub pak01: Option<Vpk>,
}

/// A map available in the install.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapEntry {
    pub name: String,
    pub size: u64,
}

impl Game {
    pub fn open(csgo: &Path) -> Result<Self, Error> {
        if !crate::steam::is_csgo_dir(csgo) {
            return Err(Error::NotCs2(csgo.to_path_buf()));
        }
        let src = DirSource::new(csgo);
        let pak01 = if csgo.join("pak01_dir.vpk").is_file() {
            Some(Vpk::open(&src, "pak01_dir.vpk").map_err(|e| Error::Parse(format!("pak01_dir.vpk: {e}")))?)
        } else {
            None
        };
        Ok(Self { csgo: csgo.to_path_buf(), src, pak01 })
    }

    /// Maps that have a package in `maps/` (`de_mirage`, ...), sorted by name. Vanity / preview /
    /// helper packages are left out.
    pub fn list_maps(csgo: &Path) -> Vec<MapEntry> {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(csgo.join("maps")) else { return out };
        for e in rd.flatten() {
            let p = e.path();
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
            let Some(stem) = name.strip_suffix(".vpk") else { continue };
            if stem.ends_with("_vanity") || stem.contains("_dir") || stem.starts_with("graphics_settings") || stem.ends_with("_preview") {
                continue;
            }
            // numbered chunks of a multi-part map package ("x_000.vpk")
            if stem.len() > 4 && stem.as_bytes()[stem.len() - 4] == b'_' && stem[stem.len() - 3..].chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(MapEntry { name: stem.to_string(), size });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// The package of `map` (`maps/<map>.vpk` or `maps/<map>_dir.vpk`).
    pub fn open_map(&self, map: &str) -> Result<Vpk, Error> {
        if !valid_map_name(map) {
            return Err(Error::MapNotFound(map.to_string()));
        }
        for rel in [format!("maps/{map}.vpk"), format!("maps/{map}_dir.vpk")] {
            if self.csgo.join(&rel).is_file() {
                return Vpk::open(&self.src, &rel).map_err(|e| Error::Parse(format!("{rel}: {e}")));
            }
        }
        Err(Error::MapNotFound(map.to_string()))
    }

    /// Files that identify the installed version of `map` (for cache keys): path, size, mtime.
    pub fn fingerprint_files(&self, map: &str) -> Vec<PathBuf> {
        vec![self.csgo.join(format!("maps/{map}.vpk")), self.csgo.join(format!("maps/{map}_dir.vpk")), self.csgo.join("pak01_dir.vpk")]
    }
}

/// Map names are plain file stems: letters, digits, `_`, `-`.
pub fn valid_map_name(map: &str) -> bool {
    !map.is_empty() && map.len() < 96 && map.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Reads compiled files from the map package first, then the shared package.
pub struct Files<'a> {
    pub game: &'a Game,
    pub map: &'a Vpk,
}

impl Files<'_> {
    /// The bytes of `path` (with or without the `_c` suffix; `\` or `/`; case-insensitive fallback).
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        let mut p = path.replace('\\', "/");
        if !p.ends_with("_c") {
            p.push_str("_c");
        }
        let lower = p.to_ascii_lowercase();
        let pkgs = std::iter::once(self.map).chain(self.game.pak01.as_ref());
        for vpk in pkgs {
            for q in [&p, &lower] {
                if vpk.get(q).is_some() {
                    if let Ok(b) = vpk.read_file(&self.game.src, q) {
                        return Some(b);
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn map_names() {
        assert!(valid_map_name("de_mirage"));
        assert!(!valid_map_name("../x"));
        assert!(!valid_map_name("a/b"));
        assert!(!valid_map_name(""));
    }
}
