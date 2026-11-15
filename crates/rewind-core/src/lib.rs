//! Rewind core: CS2 demo parsing, frames, voice and heuristic (offline) analysis.

pub mod analysis;
pub mod demo;
pub mod error;
pub mod extract;
pub mod frames;
pub mod lineups;
pub mod maps;
pub mod model;
pub mod voice;

pub use error::{Error, Result};
pub use model::DemoData;

use std::path::Path;

/// Everything produced by loading one demo.
pub struct LoadedDemo {
    pub data: DemoData,
    pub frames: frames::FrameStore,
    pub voice: voice::VoiceStore,
    /// Successful grenades of this demo, to be merged into the persistent lineup library.
    pub learned_lineups: Vec<lineups::Lineup>,
}

impl LoadedDemo {
    pub fn frames_bytes(&self) -> Vec<u8> {
        self.frames.to_bytes()
    }
    pub fn voice_pcm_bytes(&self, steam_id: &str) -> Option<Vec<u8>> {
        self.voice.decode_bytes(steam_id)
    }
}

pub struct LoadOptions<'a> {
    /// Lineup library to draw suggestions from (seed + user library). None = seed only.
    pub library: Option<&'a lineups::LineupLibrary>,
}

impl Default for LoadOptions<'_> {
    fn default() -> Self {
        LoadOptions { library: None }
    }
}

/// Loads a demo from bytes. `progress(stage, pct 0..1)` may be called from worker threads.
pub fn load_bytes(
    bytes: &[u8],
    file_name: &str,
    opts: &LoadOptions<'_>,
    progress: &(dyn Fn(&str, f32) + Sync),
) -> Result<LoadedDemo> {
    let raw = extract::extract(bytes, progress)?;
    let built = demo::build(raw, file_name, progress)?;
    progress("analysis", 0.95);
    let seed;
    let lib = match opts.library {
        Some(l) => l,
        None => {
            seed = lineups::LineupLibrary::seed();
            &seed
        }
    };
    let (data, learned) = analysis::analyze(built.data, &built.frames, &built.extra, lib);
    progress("done", 1.0);
    Ok(LoadedDemo { data, frames: built.frames, voice: built.voice, learned_lineups: learned })
}

/// Loads a demo file (memory-mapped).
pub fn load_file(path: &Path, opts: &LoadOptions<'_>, progress: &(dyn Fn(&str, f32) + Sync)) -> Result<LoadedDemo> {
    let file = std::fs::File::open(path)?;
    // SAFETY: the file is opened read-only and not modified by us while mapped; if another process
    // truncates it, reads may fault — acceptable for a desktop viewer, and the parser bounds-checks.
    let mmap = unsafe { memmap2::Mmap::map(&file)? };
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    progress("read", 0.02);
    load_bytes(&mmap, &name, opts, progress)
}
