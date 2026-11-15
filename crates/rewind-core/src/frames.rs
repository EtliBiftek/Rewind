//! Sampled per-player state ("frames") built from the tick pass.

use crate::extract::Table;
use crate::model::{frame_field as ff, frame_flag as fl, Vec3, FRAME_STRIDE};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PlayerKey {
    Steam(u64),
    Bot(String),
}

impl PlayerKey {
    pub fn new(steamid: Option<u64>, name: Option<&str>) -> Option<PlayerKey> {
        match steamid {
            Some(s) if s != 0 => Some(PlayerKey::Steam(s)),
            _ => name.filter(|n| !n.is_empty()).map(|n| PlayerKey::Bot(n.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Sample {
    pub pos: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub health: i32,
    pub armor: i32,
    pub flags: u32,
    pub flash_dur: f32,
    pub weapon: i32,
    pub money: i32,
    pub equip: i32,
    /// index into FrameStore::places, 0 = unknown
    pub place: u16,
    /// raw team number (0 none, 1 spec, 2 T, 3 CT)
    pub team: u8,
    /// true when this sample came from a real row (not carried forward / absent)
    pub present: bool,
}

impl Sample {
    pub fn alive(&self) -> bool {
        self.present && self.flags & fl::ALIVE != 0
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Rules {
    pub warmup: bool,
    pub freeze: bool,
    pub rounds_played: i32,
    pub score_t: i32,
    pub score_ct: i32,
    pub present: bool,
}

pub struct RawFrames {
    pub start_tick: i32,
    pub interval: i32,
    pub frame_count: usize,
    pub by_key: HashMap<PlayerKey, Vec<Sample>>,
    pub names: HashMap<PlayerKey, String>,
    pub clan: HashMap<PlayerKey, HashMap<String, usize>>,
    pub rules: Vec<Rules>,
    pub places: Vec<String>,
    pub weapons: Vec<String>,
    pub last_tick: i32,
}

/// Normalizes weapon display names ("AK-47", "weapon_ak47", "M4A1-S") to short ids ("ak47", "m4a1_silencer").
pub fn normalize_weapon(raw: &str) -> String {
    let s = raw.trim();
    let s = s.strip_prefix("weapon_").unwrap_or(s);
    let lower = s.to_ascii_lowercase();
    let mapped = match lower.as_str() {
        "ak-47" => "ak47",
        "m4a4" | "m4a1" => "m4a1",
        "m4a1-s" => "m4a1_silencer",
        "usp-s" => "usp_silencer",
        "glock-18" => "glock",
        "p2000" | "hkp2000" => "hkp2000",
        "desert eagle" => "deagle",
        "dual berettas" => "elite",
        "five-seven" => "fiveseven",
        "cz75-auto" => "cz75a",
        "r8 revolver" => "revolver",
        "tec-9" => "tec9",
        "p250" => "p250",
        "mac-10" => "mac10",
        "mp5-sd" => "mp5sd",
        "ump-45" => "ump45",
        "pp-bizon" => "bizon",
        "p90" => "p90",
        "mp7" => "mp7",
        "mp9" => "mp9",
        "nova" => "nova",
        "xm1014" => "xm1014",
        "mag-7" => "mag7",
        "sawed-off" => "sawedoff",
        "m249" => "m249",
        "negev" => "negev",
        "galil ar" => "galilar",
        "famas" => "famas",
        "sg 553" => "sg556",
        "aug" => "aug",
        "ssg 08" => "ssg08",
        "awp" => "awp",
        "g3sg1" => "g3sg1",
        "scar-20" => "scar20",
        "zeus x27" => "taser",
        "c4 explosive" | "c4" => "c4",
        "high explosive grenade" | "he grenade" => "hegrenade",
        "flashbang" => "flashbang",
        "smoke grenade" => "smokegrenade",
        "molotov" => "molotov",
        "incendiary grenade" => "incgrenade",
        "decoy grenade" => "decoy",
        "inferno" => "inferno",
        "planted_c4" => "c4",
        _ => "",
    };
    if !mapped.is_empty() {
        return mapped.to_string();
    }
    if lower.contains("knife") || lower.contains("bayonet") || lower.contains("karambit") || lower.contains("dagger") {
        return "knife".to_string();
    }
    lower.replace([' ', '-'], "")
}

pub fn is_firearm(w: &str) -> bool {
    !matches!(
        w,
        "knife" | "hegrenade" | "flashbang" | "smokegrenade" | "molotov" | "incgrenade" | "decoy" | "inferno" | "c4" | "taser" | "world" | "" | "worldspawn" | "trigger_hurt" | "planted_c4"
    )
}

pub fn is_grenade_weapon(w: &str) -> bool {
    matches!(w, "hegrenade" | "flashbang" | "smokegrenade" | "molotov" | "incgrenade" | "decoy")
}

struct Interner {
    map: HashMap<String, usize>,
    list: Vec<String>,
}
impl Interner {
    fn new(first: Option<&str>) -> Self {
        let mut s = Interner { map: HashMap::new(), list: vec![] };
        if let Some(f) = first {
            s.get(f);
        }
        s
    }
    fn get(&mut self, k: &str) -> usize {
        if let Some(&i) = self.map.get(k) {
            return i;
        }
        let i = self.list.len();
        self.list.push(k.to_string());
        self.map.insert(k.to_string(), i);
        i
    }
}

pub fn build_raw_frames(t: &Table, interval: i32) -> RawFrames {
    let n = t.rows;
    let col = |name: &str| t.col(name);
    let tick_c = col("tick");
    let sid_c = col("steamid");
    let name_c = col("name");
    let mut min_tick = i32::MAX;
    let mut max_tick = i32::MIN;
    if let Some(tc) = &tick_c {
        for r in 0..n {
            if let Some(tk) = tc.num(r) {
                min_tick = min_tick.min(tk as i32);
                max_tick = max_tick.max(tk as i32);
            }
        }
    }
    if min_tick == i32::MAX {
        return RawFrames {
            start_tick: 0,
            interval,
            frame_count: 0,
            by_key: HashMap::new(),
            names: HashMap::new(),
            clan: HashMap::new(),
            rules: vec![],
            places: vec![String::new()],
            weapons: vec![],
            last_tick: 0,
        };
    }
    let start = min_tick;
    let frame_count = ((max_tick - start) / interval + 1) as usize;
    let mut by_key: HashMap<PlayerKey, Vec<Sample>> = HashMap::new();
    let mut names = HashMap::new();
    let mut clan: HashMap<PlayerKey, HashMap<String, usize>> = HashMap::new();
    let mut rules = vec![Rules::default(); frame_count];
    let mut places = Interner::new(Some(""));
    let mut weapons = Interner::new(None);

    let c = |name: &str| col(name);
    let (cx, cy, cz, cyaw, cpitch) = (c("X"), c("Y"), c("Z"), c("yaw"), c("pitch"));
    let (chp, carmor, calive, cteam) = (c("health"), c("armor_value"), c("is_alive"), c("team_num"));
    let (cduck, cscoped, cdefusing, ckit, chelmet) =
        (c("duck_amount"), c("is_scoped"), c("is_defusing"), c("has_defuser"), c("has_helmet"));
    let (cair, cwalk, cflash, cweap, cmoney, cequip, cconn, cplace) = (
        c("is_airborne"),
        c("is_walking"),
        c("flash_duration"),
        c("active_weapon_name"),
        c("balance"),
        c("current_equip_value"),
        c("is_connected"),
        c("last_place_name"),
    );
    let (cwarm, cfreeze, crp, cscore, cclan) = (
        c("is_warmup_period"),
        c("is_freeze_period"),
        c("total_rounds_played"),
        c("team_rounds_total"),
        c("team_clan_name"),
    );
    let num = |cc: &Option<crate::extract::Column<'_>>, r: usize| cc.as_ref().and_then(|c| c.num(r));
    let boolean = |cc: &Option<crate::extract::Column<'_>>, r: usize| num(cc, r).map(|v| v != 0.0).unwrap_or(false);

    for r in 0..n {
        let Some(tick) = num(&tick_c, r) else { continue };
        let tick = tick as i32;
        if (tick - start) % interval != 0 {
            continue;
        }
        let f = ((tick - start) / interval) as usize;
        let sid = sid_c.as_ref().and_then(|c| c.u64(r));
        let name = name_c.as_ref().and_then(|c| c.str(r));
        let Some(key) = PlayerKey::new(sid, name) else { continue };
        if let Some(nm) = name {
            names.entry(key.clone()).or_insert_with(|| nm.to_string());
        }
        let team = num(&cteam, r).unwrap_or(0.0) as u8;
        // game rules (same for every row of a tick)
        let rl = &mut rules[f];
        if !rl.present {
            rl.present = true;
            rl.warmup = boolean(&cwarm, r);
            rl.freeze = boolean(&cfreeze, r);
            rl.rounds_played = num(&crp, r).unwrap_or(0.0) as i32;
        }
        if let Some(sc) = num(&cscore, r) {
            match team {
                2 => rl.score_t = sc as i32,
                3 => rl.score_ct = sc as i32,
                _ => {}
            }
        }
        if let Some(cn) = cclan.as_ref().and_then(|c| c.str(r)) {
            if !cn.is_empty() && (team == 2 || team == 3) {
                *clan.entry(key.clone()).or_default().entry(cn.to_string()).or_default() += 1;
            }
        }
        let health = num(&chp, r).unwrap_or(0.0) as i32;
        let alive = match num(&calive, r) {
            Some(v) => v != 0.0 && health > 0,
            None => health > 0,
        };
        let connected = match num(&cconn, r) {
            Some(v) => v == 0.0,
            None => true,
        };
        let mut flags = 0u32;
        if connected {
            flags |= fl::CONNECTED;
        }
        if alive {
            flags |= fl::ALIVE;
        }
        if team == 3 {
            flags |= fl::SIDE_CT;
        }
        if num(&cduck, r).unwrap_or(0.0) > 0.5 {
            flags |= fl::DUCKING;
        }
        if boolean(&cscoped, r) {
            flags |= fl::SCOPED;
        }
        if boolean(&cdefusing, r) {
            flags |= fl::DEFUSING;
        }
        if boolean(&ckit, r) {
            flags |= fl::HAS_DEFUSER;
        }
        if boolean(&chelmet, r) {
            flags |= fl::HAS_HELMET;
        }
        if boolean(&cair, r) {
            flags |= fl::AIRBORNE;
        }
        if boolean(&cwalk, r) {
            flags |= fl::WALKING;
        }
        let weapon = match cweap.as_ref().and_then(|c| c.str(r)) {
            Some(w) if alive && !w.is_empty() => weapons.get(&normalize_weapon(w)) as i32,
            _ => -1,
        };
        let place = match cplace.as_ref().and_then(|c| c.str(r)) {
            Some(p) if !p.is_empty() => places.get(p).min(u16::MAX as usize) as u16,
            _ => 0,
        };
        let s = Sample {
            pos: [
                num(&cx, r).unwrap_or(0.0) as f32,
                num(&cy, r).unwrap_or(0.0) as f32,
                num(&cz, r).unwrap_or(0.0) as f32,
            ],
            yaw: num(&cyaw, r).unwrap_or(0.0) as f32,
            pitch: num(&cpitch, r).unwrap_or(0.0) as f32,
            health: if alive { health } else { 0 },
            armor: if alive { num(&carmor, r).unwrap_or(0.0) as i32 } else { 0 },
            flags,
            flash_dur: num(&cflash, r).unwrap_or(0.0) as f32,
            weapon,
            money: num(&cmoney, r).unwrap_or(0.0) as i32,
            equip: if alive { num(&cequip, r).unwrap_or(0.0) as i32 } else { 0 },
            place,
            team,
            present: true,
        };
        let v = by_key.entry(key).or_insert_with(|| vec![Sample::default(); frame_count]);
        v[f] = s;
    }
    // Fill gaps (ticks without a snapshot) by carrying the previous frame forward a little.
    let present_frames: Vec<bool> = rules.iter().map(|r| r.present).collect();
    for f in 1..frame_count {
        if !present_frames[f] {
            rules[f] = rules[f - 1];
            rules[f].present = false;
            for v in by_key.values_mut() {
                if !v[f].present && v[f - 1].present {
                    v[f] = v[f - 1];
                }
            }
        }
    }
    RawFrames {
        start_tick: start,
        interval,
        frame_count,
        by_key,
        names,
        clan,
        rules,
        places: places.list,
        weapons: weapons.list,
        last_tick: max_tick,
    }
}

/// Final frame store with players in slot order.
pub struct FrameStore {
    pub start_tick: i32,
    pub interval: i32,
    pub frame_count: usize,
    /// samples[slot][frame]
    pub samples: Vec<Vec<Sample>>,
    pub rules: Vec<Rules>,
    pub places: Vec<String>,
    pub weapons: Vec<String>,
}

impl FrameStore {
    pub fn frame_at(&self, tick: i32) -> Option<usize> {
        if self.frame_count == 0 || tick < self.start_tick {
            return None;
        }
        let f = ((tick - self.start_tick) / self.interval) as usize;
        Some(f.min(self.frame_count - 1))
    }
    /// Nearest sample at or before `tick`.
    pub fn sample(&self, slot: usize, tick: i32) -> Option<&Sample> {
        let f = self.frame_at(tick)?;
        self.samples.get(slot).map(|v| &v[f])
    }
    pub fn rules_at(&self, tick: i32) -> Option<&Rules> {
        self.frame_at(tick).map(|f| &self.rules[f])
    }
    pub fn place_name(&self, idx: u16) -> Option<&str> {
        self.places.get(idx as usize).map(|s| s.as_str()).filter(|s| !s.is_empty())
    }
    pub fn tick_of(&self, f: usize) -> i32 {
        self.start_tick + f as i32 * self.interval
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let pc = self.samples.len();
        let mut out = Vec::with_capacity(self.frame_count * pc * FRAME_STRIDE * 4);
        let mut rec = [0f32; FRAME_STRIDE];
        for f in 0..self.frame_count {
            for p in 0..pc {
                let s = &self.samples[p][f];
                if s.present {
                    rec[ff::X] = s.pos[0];
                    rec[ff::Y] = s.pos[1];
                    rec[ff::Z] = s.pos[2];
                    rec[ff::YAW] = s.yaw;
                    rec[ff::PITCH] = s.pitch;
                    rec[ff::HEALTH] = s.health as f32;
                    rec[ff::ARMOR] = s.armor as f32;
                    rec[ff::FLAGS] = s.flags as f32;
                    rec[ff::FLASH_REMAINING] = s.flash_dur;
                    rec[ff::WEAPON] = s.weapon as f32;
                    rec[ff::MONEY] = s.money as f32;
                    rec[ff::EQUIP_VALUE] = s.equip as f32;
                } else {
                    rec = [0.0; FRAME_STRIDE];
                    rec[ff::WEAPON] = -1.0;
                }
                for v in rec {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weapon_names() {
        assert_eq!(normalize_weapon("AK-47"), "ak47");
        assert_eq!(normalize_weapon("weapon_knife_t"), "knife");
        assert_eq!(normalize_weapon("M4A1-S"), "m4a1_silencer");
        assert_eq!(normalize_weapon("weapon_smokegrenade"), "smokegrenade");
        assert_eq!(normalize_weapon("Karambit"), "knife");
        assert!(is_firearm("ak47"));
        assert!(!is_firearm("hegrenade"));
    }
}
