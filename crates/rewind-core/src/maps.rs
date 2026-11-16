//! Radar transforms (CS2 overview convention). Values copied from the game's own
//! `game/csgo/pak01_dir/resource/overviews/<map>.txt` files (SteamDatabase/GameTracking-CS2
//! @ 82e2b9d62cc97f1358c68a220a4a392c9e41c509), including the "lower" vertical section split.

use crate::model::{MapInfo, Vec3};

pub struct Radar {
    pub name: &'static str,
    pub pos_x: f32,
    pub pos_y: f32,
    pub scale: f32,
    pub lower_level_max_z: Option<f32>,
}

pub const RADARS: &[Radar] = &[
    Radar { name: "de_ancient", pos_x: -2953.0, pos_y: 2164.0, scale: 5.0, lower_level_max_z: None },
    Radar { name: "de_ancient_night", pos_x: -2953.0, pos_y: 2164.0, scale: 5.0, lower_level_max_z: None },
    Radar { name: "de_anubis", pos_x: -2796.0, pos_y: 3328.0, scale: 5.22, lower_level_max_z: None },
    Radar { name: "de_cache", pos_x: -2000.0, pos_y: 3250.0, scale: 5.5, lower_level_max_z: None },
    Radar { name: "de_dust", pos_x: -2850.0, pos_y: 4073.0, scale: 6.0, lower_level_max_z: None },
    Radar { name: "de_dust2", pos_x: -2476.0, pos_y: 3239.0, scale: 4.4, lower_level_max_z: None },
    Radar { name: "de_inferno", pos_x: -2087.0, pos_y: 3870.0, scale: 4.9, lower_level_max_z: None },
    Radar { name: "de_mirage", pos_x: -3230.0, pos_y: 1713.0, scale: 5.0, lower_level_max_z: None },
    Radar { name: "de_nuke", pos_x: -3453.0, pos_y: 2887.0, scale: 7.0, lower_level_max_z: Some(-495.0) },
    Radar { name: "de_overpass", pos_x: -4831.0, pos_y: 1781.0, scale: 5.2, lower_level_max_z: None },
    Radar { name: "de_train", pos_x: -2308.0, pos_y: 2078.0, scale: 4.082077, lower_level_max_z: Some(-50.0) },
    Radar { name: "de_vertigo", pos_x: -3168.0, pos_y: 1762.0, scale: 4.0, lower_level_max_z: Some(11700.0) },
    Radar { name: "cs_italy", pos_x: -2647.0, pos_y: 2592.0, scale: 4.6, lower_level_max_z: None },
    Radar { name: "cs_office", pos_x: -1838.0, pos_y: 1858.0, scale: 4.1, lower_level_max_z: None },
    Radar { name: "ar_baggage", pos_x: -1316.0, pos_y: 1288.0, scale: 2.539062, lower_level_max_z: None },
    Radar { name: "ar_shoots", pos_x: -1368.0, pos_y: 1952.0, scale: 2.6875, lower_level_max_z: None },
];

/// Normalizes e.g. "workshop/123/de_mirage" or "de_mirage_v2" style names to a known radar.
pub fn find_radar(map_name: &str) -> Option<&'static Radar> {
    let base = map_name.rsplit(['/', '\\']).next().unwrap_or(map_name).to_ascii_lowercase();
    if let Some(r) = RADARS.iter().find(|r| r.name == base) {
        return Some(r);
    }
    // Variants such as de_inferno_s2 / de_ancient_v2 share the base map's overview.
    RADARS
        .iter()
        .filter(|r| base.starts_with(r.name) && base[r.name.len()..].starts_with('_'))
        .max_by_key(|r| r.name.len())
}

/// Builds MapInfo; unknown maps get a transform fitted to the observed player positions
/// (square 1024px image with a 5% margin).
pub fn map_info(map_name: &str, bounds_min: Vec3, bounds_max: Vec3) -> MapInfo {
    if let Some(r) = find_radar(map_name) {
        return MapInfo {
            name: map_name.to_string(),
            pos_x: r.pos_x,
            pos_y: r.pos_y,
            scale: r.scale,
            lower_level_max_z: r.lower_level_max_z,
            known: true,
            bounds_min,
            bounds_max,
        };
    }
    let valid = bounds_min[0] <= bounds_max[0] && bounds_min[1] <= bounds_max[1];
    let (min, max) = if valid { (bounds_min, bounds_max) } else { ([-4096.0; 3], [4096.0; 3]) };
    let w = (max[0] - min[0]).max(max[1] - min[1]).max(256.0) * 1.1;
    let cx = (min[0] + max[0]) / 2.0;
    let cy = (min[1] + max[1]) / 2.0;
    MapInfo {
        name: map_name.to_string(),
        pos_x: cx - w / 2.0,
        pos_y: cy + w / 2.0,
        scale: w / 1024.0,
        lower_level_max_z: None,
        known: false,
        bounds_min: min,
        bounds_max: max,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_variants() {
        assert_eq!(find_radar("de_mirage").unwrap().name, "de_mirage");
        assert_eq!(find_radar("de_inferno_s2").unwrap().name, "de_inferno");
        assert_eq!(find_radar("workshop/123/de_nuke").unwrap().name, "de_nuke");
        assert!(find_radar("de_unknownmap").is_none());
    }
    #[test]
    fn fitted_transform_contains_bounds() {
        let m = map_info("de_x", [-1000.0, -500.0, 0.0], [3000.0, 2500.0, 100.0]);
        assert!(!m.known);
        for (x, y) in [(-1000.0f32, -500.0f32), (3000.0, 2500.0)] {
            let px = (x - m.pos_x) / m.scale;
            let py = (m.pos_y - y) / m.scale;
            assert!((0.0..=1024.0).contains(&px) && (0.0..=1024.0).contains(&py));
        }
    }
}
