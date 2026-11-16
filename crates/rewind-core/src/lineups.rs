//! Persistent lineup library: successful grenades clustered by throw spot / aim / landing spot.

use crate::model::{GrenadeType, Side, Vec3};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineup {
    pub map: String,
    #[serde(rename = "type")]
    pub kind: GrenadeType,
    pub side: Side,
    pub from: Vec3,
    #[serde(default)]
    pub from_place: Option<String>,
    pub yaw: f32,
    pub pitch: f32,
    pub style: String,
    pub land: Vec3,
    #[serde(default)]
    pub land_place: Option<String>,
    /// flat [x, y, z, ...]
    #[serde(default)]
    pub trajectory: Vec<f32>,
    pub support: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    pub version: u32,
    pub demos: u32,
    #[serde(default)]
    pub demo_ids: Vec<String>,
    pub lineups: Vec<Lineup>,
}

#[derive(Debug, Clone, Default)]
pub struct LineupLibrary {
    pub seed: Vec<Lineup>,
    pub user: LibraryFile,
}

const SEED_JSON: &str = include_str!("../seed/lineups_seed.json");

impl LineupLibrary {
    pub fn seed() -> LineupLibrary {
        let f: LibraryFile = serde_json::from_str(SEED_JSON).unwrap_or_default();
        LineupLibrary { seed: f.lineups, user: LibraryFile { version: 1, ..Default::default() } }
    }
    pub fn load(path: &Path) -> LineupLibrary {
        let mut lib = Self::seed();
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(f) = serde_json::from_str::<LibraryFile>(&s) {
                lib.user = f;
            }
        }
        lib
    }
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&self.user).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, path)
    }
    /// Merges the successful throws of one demo. Returns false if the demo was already merged.
    pub fn merge_demo(&mut self, demo_id: &str, throws: &[Lineup]) -> bool {
        if self.user.demo_ids.iter().any(|d| d == demo_id) {
            return false;
        }
        self.user.demo_ids.push(demo_id.to_string());
        self.user.demos += 1;
        for t in throws {
            merge_into(&mut self.user.lineups, t.clone());
        }
        true
    }
    pub fn stats(&self) -> crate::model::LibraryStats {
        let mut by_map: BTreeMap<String, u32> = BTreeMap::new();
        for l in self.seed.iter().chain(self.user.lineups.iter()) {
            *by_map.entry(l.map.clone()).or_default() += 1;
        }
        crate::model::LibraryStats { demos: self.user.demos, lineups_by_map: by_map }
    }
}

fn d3(a: Vec3, b: Vec3) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn ang_diff(a: f32, b: f32) -> f32 {
    let mut d = (a - b) % 360.0;
    if d > 180.0 {
        d -= 360.0;
    }
    if d < -180.0 {
        d += 360.0;
    }
    d.abs()
}

/// Same lineup = same map/type/side/style, thrown from (almost) the same spot with (almost) the same
/// aim and landing at (almost) the same spot.
pub fn same_lineup(a: &Lineup, b: &Lineup) -> bool {
    // smokes are precise lineups; flashes/molotovs/HEs are thrown more loosely
    let (from_r, ang, land_r) = match a.kind {
        GrenadeType::Smoke => (48.0, 2.5, 128.0),
        _ => (80.0, 4.0, 180.0),
    };
    a.map == b.map
        && a.kind == b.kind
        && a.side == b.side
        && a.style == b.style
        && d3(a.from, b.from) < from_r
        && ang_diff(a.yaw, b.yaw) < ang
        && (a.pitch - b.pitch).abs() < ang
        && d3(a.land, b.land) < land_r
}

#[cfg(test)]
mod tests {
    use super::*;
    fn l(from: Vec3, yaw: f32, land: Vec3) -> Lineup {
        Lineup {
            map: "de_mirage".into(),
            kind: GrenadeType::Smoke,
            side: Side::T,
            from,
            from_place: None,
            yaw,
            pitch: -10.0,
            style: "jump".into(),
            land,
            land_place: None,
            trajectory: vec![],
            support: 1,
        }
    }
    #[test]
    fn clustering_and_persistence() {
        let mut lib = LineupLibrary::default();
        let a = l([0.0, 0.0, 0.0], 179.0, [1000.0, 0.0, 0.0]);
        let b = l([10.0, 5.0, 0.0], -179.5, [1050.0, 20.0, 0.0]); // same lineup (yaw wraps)
        let c = l([500.0, 0.0, 0.0], 90.0, [1000.0, 0.0, 0.0]); // different throw spot
        assert!(lib.merge_demo("d1", &[a.clone(), b, c]));
        assert!(!lib.merge_demo("d1", &[a]), "same demo is not merged twice");
        assert_eq!(lib.user.lineups.len(), 2);
        assert_eq!(lib.user.lineups[0].support, 2);
        let dir = std::env::temp_dir().join(format!("rewind-lib-test-{}", std::process::id()));
        let path = dir.join("lineups.json");
        lib.save(&path).unwrap();
        let back = LineupLibrary::load(&path);
        assert_eq!(back.user.lineups.len(), 2);
        assert_eq!(back.user.demos, 1);
        assert!(back.stats().lineups_by_map.get("de_mirage").copied().unwrap_or(0) >= 2);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn seed_parses() {
        let s = LineupLibrary::seed();
        assert!(!s.seed.is_empty(), "bundled seed library is not empty");
        assert!(s.seed.iter().all(|l| l.support >= 2));
    }
}

pub fn merge_into(list: &mut Vec<Lineup>, t: Lineup) {
    if let Some(l) = list.iter_mut().find(|l| same_lineup(l, &t)) {
        l.support += t.support.max(1);
        if l.land_place.is_none() {
            l.land_place = t.land_place;
        }
        if l.from_place.is_none() {
            l.from_place = t.from_place;
        }
        return;
    }
    list.push(t);
}
