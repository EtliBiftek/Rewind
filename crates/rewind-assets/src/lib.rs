//! Rewind's reader for the map assets of the user's own Counter-Strike 2 install.
//!
//! Nothing of Valve's is bundled: the install is located at runtime ([`steam::discover`]), the
//! map package `game/csgo/maps/<map>.vpk` and the shared `pak01_dir.vpk` are read in place, and
//! the world is converted to one binary glTF ([`export::export_map`]) that is cached locally
//! ([`cache`]).
//!
//! Source 2 container/KV3/texture/mesh parsing comes from a vendored copy of the `heatel` crate
//! (MIT); the world, aggregate, LoD and material rules are ported from Source 2 Viewer
//! (ValveResourceFormat, MIT). See `NOTICE`.

pub mod actors;
pub mod cache;
pub mod export;
pub mod game;
pub mod glb;
pub mod material;
pub mod steam;
pub mod texture;

pub use export::{export_map, ExportOptions, ExportStats, Exported};
pub use game::{Game, MapEntry};
pub use heatel;
pub use texture::TexFormat;

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Low,
    Medium,
    High,
}

impl Quality {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "low" | "dusuk" | "düşük" => Some(Self::Low),
            "medium" | "orta" => Some(Self::Medium),
            "high" | "yuksek" | "yüksek" => Some(Self::High),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
    /// Largest texture side.
    pub fn max_texture(self) -> u32 {
        match self {
            Self::Low => 256,
            Self::Medium => 512,
            Self::High => 1024,
        }
    }
    /// Size of the spatial cells geometry is batched into (Source units): larger = fewer draw calls.
    pub fn cell_size(self) -> f32 {
        match self {
            Self::Low => 4096.0,
            Self::Medium => 3072.0,
            Self::High => 2048.0,
        }
    }
}

/// Errors; `Display` is Turkish (shown to the user as is).
#[derive(Debug)]
pub enum Error {
    NotFound,
    NotCs2(PathBuf),
    MapNotFound(String),
    Parse(String),
    Io(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NotFound => write!(f, "Counter-Strike 2 kurulumu bulunamadı. Ayarlardan CS2 klasörünü seçin."),
            Error::NotCs2(p) => write!(f, "Seçilen klasör bir CS2 kurulumu değil (game/csgo/pak01_dir.vpk yok): {}", p.display()),
            Error::MapNotFound(m) => write!(f, "Bu harita CS2 kurulumunda bulunamadı: {m}"),
            Error::Parse(e) => write!(f, "Harita dosyaları okunamadı: {e}"),
            Error::Io(e) => write!(f, "Dosya hatası: {e}"),
        }
    }
}

impl std::error::Error for Error {}
