//! Turkish text helpers. Sentences are built so that proper nouns (player names, callouts,
//! weapons) never need a Turkish suffix (vowel harmony can't be guessed reliably for them).

use crate::model::{GrenadeType, Side};

/// Human readable callout ("PalaceAlley" -> "Palace Alley", "BombsiteA" -> "A bölgesi").
pub fn place(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let fixed = match lower.as_str() {
        "bombsitea" => Some("A bölgesi"),
        "bombsiteb" => Some("B bölgesi"),
        "tspawn" => Some("T başlangıcı"),
        "ctspawn" => Some("CT başlangıcı"),
        _ => None,
    };
    if let Some(f) = fixed {
        return Some(f.to_string());
    }
    // split CamelCase / digits
    let mut out = String::new();
    let chars: Vec<char> = raw.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 {
            let prev = chars[i - 1];
            let next = chars.get(i + 1).copied();
            let boundary = (c.is_uppercase() && (prev.is_lowercase() || prev.is_ascii_digit()))
                || (c.is_uppercase() && prev.is_uppercase() && next.map(|n| n.is_lowercase()).unwrap_or(false))
                || (c.is_ascii_digit() && prev.is_alphabetic());
            if boundary {
                out.push(' ');
            }
        }
        out.push(if *c == '_' { ' ' } else { *c });
    }
    // "Topof Mid" style artifacts: lowercase connector words that were glued
    let out = out.replace("Topof ", "Top of ").replace("Bottomof ", "Bottom of ");
    Some(out)
}

pub fn place_or(raw: Option<&str>, fallback: &str) -> String {
    place(raw).unwrap_or_else(|| fallback.to_string())
}

pub fn weapon(w: &str) -> String {
    match w {
        "ak47" => "AK-47",
        "m4a1" => "M4A4",
        "m4a1_silencer" => "M4A1-S",
        "awp" => "AWP",
        "deagle" => "Desert Eagle",
        "usp_silencer" => "USP-S",
        "hkp2000" => "P2000",
        "glock" => "Glock-18",
        "elite" => "Dual Berettas",
        "fiveseven" => "Five-SeveN",
        "cz75a" => "CZ75-Auto",
        "revolver" => "R8",
        "tec9" => "Tec-9",
        "p250" => "P250",
        "mac10" => "MAC-10",
        "mp5sd" => "MP5-SD",
        "ump45" => "UMP-45",
        "bizon" => "PP-Bizon",
        "p90" => "P90",
        "mp7" => "MP7",
        "mp9" => "MP9",
        "nova" => "Nova",
        "xm1014" => "XM1014",
        "mag7" => "MAG-7",
        "sawedoff" => "Sawed-Off",
        "m249" => "M249",
        "negev" => "Negev",
        "galilar" => "Galil AR",
        "famas" => "FAMAS",
        "sg556" => "SG 553",
        "aug" => "AUG",
        "ssg08" => "SSG 08",
        "g3sg1" => "G3SG1",
        "scar20" => "SCAR-20",
        "taser" => "Zeus",
        "knife" => "bıçak",
        "hegrenade" => "HE bombası",
        "inferno" | "molotov" | "incgrenade" => "molotof",
        "flashbang" => "flaş",
        "smokegrenade" => "smoke",
        "decoy" => "decoy",
        "c4" => "C4",
        "world" => "dünya hasarı",
        other => return other.to_uppercase(),
    }
    .to_string()
}

pub fn style(s: &str) -> &'static str {
    match s {
        "jump" => "zıplayarak",
        "run" => "koşarak",
        "walk" => "yürüyerek",
        "crouch" => "eğilerek",
        _ => "durarak",
    }
}

pub fn grenade(g: GrenadeType) -> &'static str {
    g.tr()
}

pub fn side(s: Side) -> &'static str {
    match s {
        Side::T => "T",
        Side::CT => "CT",
    }
}

pub fn secs(x: f32) -> String {
    let r = (x * 10.0).round() / 10.0;
    if (r - r.round()).abs() < 1e-3 {
        format!("{}", r.round() as i64)
    } else {
        format!("{r:.1}").replace('.', ",")
    }
}

pub fn round_reason(reason: &str) -> &'static str {
    match reason {
        "bomb_exploded" => "bomba patladı",
        "bomb_defused" => "bomba imha edildi",
        "t_eliminated" => "T takımı tamamen elendi",
        "ct_eliminated" => "CT takımı tamamen elendi",
        "time_expired" => "süre doldu",
        "t_surrender" => "T takımı teslim oldu",
        "ct_surrender" => "CT takımı teslim oldu",
        _ => "raund sona erdi",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn places() {
        assert_eq!(place(Some("PalaceAlley")).unwrap(), "Palace Alley");
        assert_eq!(place(Some("BombsiteA")).unwrap(), "A bölgesi");
        assert_eq!(place(Some("TopofMid")).unwrap(), "Top of Mid");
        assert_eq!(place(Some("CTSpawn")).unwrap(), "CT başlangıcı");
        assert_eq!(place(Some("")), None);
        assert_eq!(secs(2.0), "2");
        assert_eq!(secs(2.34), "2,3");
    }
}
