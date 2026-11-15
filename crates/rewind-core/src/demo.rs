//! Converts raw parser output into the contract model (`DemoData`) plus the frame and voice
//! stores and some extra per-event context the analyzer needs.

use crate::extract::{Ev, RawDemo, Table};
use crate::frames::{build_raw_frames, is_firearm, is_grenade_weapon, normalize_weapon, FrameStore, PlayerKey, RawFrames, Sample};
use crate::maps;
use crate::model::*;
use crate::voice::{self, VoiceStore};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const TICK_RATE: f32 = 64.0;

/// Extra per-kill context (aligned with `DemoData::kills`).
#[derive(Debug, Clone, Default)]
pub struct DeathCtx {
    pub victim_inventory: Vec<String>,
    pub victim_weapon: String,
    pub victim_yaw: Option<f32>,
    pub attacker_yaw: Option<f32>,
    pub victim_place: Option<String>,
    pub attacker_place: Option<String>,
    pub attacker_health: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct Purchase {
    pub tick: i32,
    pub round: u32,
    pub slot: usize,
    pub item: String,
    pub cost: i32,
}

pub struct Extra {
    pub deaths: Vec<DeathCtx>,
    /// (tick, slot)
    pub reloads: Vec<(i32, usize)>,
    pub purchases: Vec<Purchase>,
    /// final in-game score per constant team, if the demo exposes it
    pub final_score_from_game: Option<[u32; 2]>,
    /// per round: side of each slot (None if not playing)
    pub round_sides: Vec<Vec<Option<Side>>>,
}

pub struct Built {
    pub data: DemoData,
    pub frames: FrameStore,
    pub voice: VoiceStore,
    pub extra: Extra,
}

fn round_reason(e: &Ev) -> String {
    let code = e.int("reason");
    let s = e.str("reason").map(|s| s.to_string());
    let raw = match (s, code) {
        (Some(s), _) => s,
        (None, Some(c)) => match c {
            1 => "bomb_exploded".into(),
            7 => "bomb_defused".into(),
            8 => "t_killed".into(),
            9 => "ct_killed".into(),
            10 => "draw".into(),
            12 => "time_ran_out".into(),
            16 => "game_start".into(),
            17 => "t_surrender".into(),
            18 => "ct_surrender".into(),
            19 => "t_planted".into(),
            _ => format!("reason_{c}"),
        },
        _ => "unknown".into(),
    };
    match raw.as_str() {
        "t_killed" => "t_eliminated".into(),
        "ct_killed" => "ct_eliminated".into(),
        "time_ran_out" | "target_saved" | "t_saved" => "time_expired".into(),
        "bomb_exploded" | "target_bombed" => "bomb_exploded".into(),
        other => other.to_string(),
    }
}

fn round_winner(e: &Ev) -> Option<Side> {
    if let Some(s) = e.str("winner") {
        return match s {
            "CT" | "ct" | "3" => Some(Side::CT),
            "T" | "t" | "2" => Some(Side::T),
            _ => None,
        };
    }
    e.int("winner").and_then(Side::from_team_num)
}

struct RoundDraft {
    start: i32,
    freeze_end: i32,
    end: i32,
    official_end: i32,
    winner: Option<Side>,
    reason: String,
    rounds_played: i32,
}

fn first_in<'a>(evs: &'a [&'a Ev], lo: i32, hi: i32) -> Option<&'a Ev> {
    evs.iter().copied().find(|e| e.tick > lo && e.tick <= hi)
}
fn last_in<'a>(evs: &'a [&'a Ev], lo: i32, hi: i32) -> Option<&'a Ev> {
    evs.iter().rev().copied().find(|e| e.tick > lo && e.tick <= hi)
}

fn detect_rounds(events: &[Ev], raw: &RawFrames, last_tick: i32) -> Vec<RoundDraft> {
    let by = |n: &str| -> Vec<&Ev> { events.iter().filter(|e| e.name == n).collect() };
    let ends = by("round_end");
    let starts = by("round_start");
    let freezes = by("round_freeze_end");
    let officials = by("round_officially_ended");
    let match_start = by("begin_new_match").last().map(|e| e.tick).unwrap_or(i32::MIN);
    let rules_at = |tick: i32| {
        if raw.frame_count == 0 || tick < raw.start_tick {
            return None;
        }
        let f = (((tick - raw.start_tick) / raw.interval) as usize).min(raw.frame_count - 1);
        Some(raw.rules[f])
    };
    let fires: Vec<(i32, bool)> = events
        .iter()
        .filter(|e| e.name == "weapon_fire")
        .map(|e| (e.tick, is_firearm(&normalize_weapon(e.str("weapon").unwrap_or("")))))
        .collect();
    let purchases: Vec<i32> = events.iter().filter(|e| e.name == "item_purchase").map(|e| e.tick).collect();

    let mut drafts: Vec<RoundDraft> = vec![];
    let mut prev_end = match_start.max(i32::MIN + 1);
    let mut last_end_tick: Option<i32> = None;
    for e in ends {
        if e.tick <= match_start {
            continue;
        }
        let Some(winner) = round_winner(e) else { continue };
        let reason = round_reason(e);
        if reason == "game_start" || reason == "draw" {
            continue;
        }
        // duplicated round_end events
        if last_end_tick.map(|l| e.tick - l < 3 * 64).unwrap_or(false) {
            continue;
        }
        last_end_tick = Some(e.tick);
        if let Some(r) = rules_at(e.tick) {
            if r.warmup && r.present {
                prev_end = e.tick;
                continue;
            }
        }
        let lo = prev_end.max(i32::MIN + 1);
        // older demos have no round_freeze_end event: fall back to the game rules' freeze flag
        let rules_freeze_end = || -> Option<i32> {
            let st = last_in(&starts, lo, e.tick)?.tick;
            let mut t = st;
            while t < e.tick {
                if let Some(r) = rules_at(t) {
                    if r.present && !r.freeze && t > st {
                        return Some(t);
                    }
                }
                t += raw.interval.max(1);
            }
            None
        };
        let freeze_end = match last_in(&freezes, lo, e.tick).map(|f| f.tick).or_else(rules_freeze_end) {
            Some(f) => f,
            None => {
                // demo started mid-round (or restart without freeze time): skip partial round
                prev_end = e.tick;
                continue;
            }
        };
        let start = last_in(&starts, lo, freeze_end).map(|s| s.tick).unwrap_or_else(|| {
            if prev_end > i32::MIN + 1 {
                prev_end
            } else {
                (freeze_end - 20 * 64).max(0)
            }
        });
        let rounds_played = rules_at(freeze_end + 8).map(|r| r.rounds_played).unwrap_or(0);
        // knife round: no firearm shots and no purchases
        let shots = fires.iter().filter(|(t, fa)| *t >= freeze_end && *t <= e.tick && *fa).count();
        let bought = purchases.iter().filter(|t| **t >= start && **t <= e.tick).count();
        if shots == 0 && bought == 0 {
            prev_end = e.tick;
            continue;
        }
        drafts.push(RoundDraft {
            start,
            freeze_end,
            end: e.tick,
            official_end: e.tick,
            winner: Some(winner),
            reason,
            rounds_played,
        });
        prev_end = e.tick;
    }
    // backup restores: a round whose rounds_played is not larger than an earlier one replaces it
    let rp_valid = drafts.iter().any(|d| d.rounds_played > 0);
    if rp_valid {
        let mut kept: Vec<RoundDraft> = vec![];
        for d in drafts {
            while kept.last().map(|k| k.rounds_played >= d.rounds_played).unwrap_or(false) {
                kept.pop();
            }
            kept.push(d);
        }
        drafts = kept;
    }
    // official ends
    for i in 0..drafts.len() {
        let next_start = drafts.get(i + 1).map(|d| d.start).unwrap_or(last_tick);
        let off = first_in(&officials, drafts[i].end, next_start.max(drafts[i].end)).map(|e| e.tick);
        drafts[i].official_end = off.unwrap_or(if i + 1 < drafts.len() { (next_start - 1).max(drafts[i].end) } else { last_tick.max(drafts[i].end) });
    }
    drafts
}

/// Resolves event player references to slots.
pub struct SlotMap {
    by_key: HashMap<PlayerKey, usize>,
    by_name: HashMap<String, usize>,
}

impl SlotMap {
    pub fn of(&self, e: &Ev, prefix: &str) -> Option<usize> {
        let key = PlayerKey::new(e.steamid(prefix), e.pname(prefix))?;
        if let Some(&s) = self.by_key.get(&key) {
            return Some(s);
        }
        e.pname(prefix).and_then(|n| self.by_name.get(n).copied())
    }
    pub fn of_steam(&self, sid: u64) -> Option<usize> {
        self.by_key.get(&PlayerKey::Steam(sid)).copied()
    }
}

fn dist(a: Vec3, b: Vec3) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn hitgroup(s: &str) -> String {
    match s {
        "head" | "neck" => "head",
        "chest" => "chest",
        "stomach" => "stomach",
        "left_arm" | "right_arm" | "arm" => "arm",
        "left_leg" | "right_leg" | "leg" => "leg",
        _ => "generic",
    }
    .to_string()
}

fn grenade_type_of_weapon(w: &str) -> Option<GrenadeType> {
    match w {
        "smokegrenade" => Some(GrenadeType::Smoke),
        "flashbang" => Some(GrenadeType::Flash),
        "hegrenade" => Some(GrenadeType::He),
        "molotov" | "incgrenade" => Some(GrenadeType::Molotov),
        "decoy" => Some(GrenadeType::Decoy),
        _ => None,
    }
}

fn grenade_type_of_class(c: &str) -> Option<GrenadeType> {
    if c.contains("Smoke") {
        Some(GrenadeType::Smoke)
    } else if c.contains("Flash") {
        Some(GrenadeType::Flash)
    } else if c.contains("HEGrenade") {
        Some(GrenadeType::He)
    } else if c.contains("Molotov") || c.contains("Incendiary") {
        Some(GrenadeType::Molotov)
    } else if c.contains("Decoy") {
        Some(GrenadeType::Decoy)
    } else {
        None
    }
}

struct ProjRun {
    eid: i32,
    kind: GrenadeType,
    thrower: Option<u64>,
    thrower_name: Option<String>,
    pts: Vec<(i32, Vec3)>,
    used: bool,
}

fn projectile_runs(t: &Table) -> Vec<ProjRun> {
    let (Some(ct), Some(ce), Some(cty), Some(cx), Some(cy), Some(cz)) =
        (t.col("tick"), t.col("grenade_entity_id"), t.col("grenade_type"), t.col("x"), t.col("y"), t.col("z"))
    else {
        return vec![];
    };
    let cs = t.col("steamid");
    let cn = t.col("name");
    let mut rows: Vec<(i32, i32, usize)> = vec![];
    for r in 0..t.rows {
        if let (Some(tick), Some(eid)) = (ct.num(r), ce.num(r)) {
            rows.push((eid as i32, tick as i32, r));
        }
    }
    rows.sort();
    let mut runs: Vec<ProjRun> = vec![];
    for (eid, tick, r) in rows {
        let Some(kind) = cty.str(r).and_then(grenade_type_of_class) else { continue };
        let (Some(x), Some(y), Some(z)) = (cx.num(r), cy.num(r), cz.num(r)) else { continue };
        let pos = [x as f32, y as f32, z as f32];
        let sid = cs.as_ref().and_then(|c| c.u64(r)).filter(|s| *s != 0);
        let name = cn.as_ref().and_then(|c| c.str(r)).map(|s| s.to_string());
        let cont = runs.last().map(|l: &ProjRun| l.eid == eid && l.kind == kind && tick - l.pts.last().unwrap().0 <= 16).unwrap_or(false);
        if cont {
            let l = runs.last_mut().unwrap();
            if l.pts.last().unwrap().0 != tick {
                l.pts.push((tick, pos));
            }
        } else {
            runs.push(ProjRun { eid, kind, thrower: sid, thrower_name: name, pts: vec![(tick, pos)], used: false });
        }
    }
    runs.sort_by_key(|r| r.pts[0].0);
    runs
}

/// Spatial lookup of callout names from player samples.
pub struct PlaceIndex {
    cells: HashMap<(i32, i32), Vec<(Vec3, u16)>>,
}

const PLACE_CELL: f32 = 192.0;

impl PlaceIndex {
    pub fn build(fs: &FrameStore) -> PlaceIndex {
        let mut cells: HashMap<(i32, i32), Vec<(Vec3, u16)>> = HashMap::new();
        for s in fs.samples.iter() {
            for (i, smp) in s.iter().enumerate() {
                if i % 2 != 0 || !smp.alive() || smp.place == 0 {
                    continue;
                }
                let k = ((smp.pos[0] / PLACE_CELL).floor() as i32, (smp.pos[1] / PLACE_CELL).floor() as i32);
                let v = cells.entry(k).or_default();
                if v.len() < 64 && !v.iter().any(|(p, pl)| *pl == smp.place && dist(*p, smp.pos) < 48.0) {
                    v.push((smp.pos, smp.place));
                }
            }
        }
        PlaceIndex { cells }
    }
    pub fn lookup<'a>(&self, fs: &'a FrameStore, pos: Vec3) -> Option<&'a str> {
        let kx = (pos[0] / PLACE_CELL).floor() as i32;
        let ky = (pos[1] / PLACE_CELL).floor() as i32;
        let mut best: Option<(f32, u16)> = None;
        for dx in -2..=2 {
            for dy in -2..=2 {
                if let Some(v) = self.cells.get(&(kx + dx, ky + dy)) {
                    for (p, pl) in v {
                        // vertical distance matters (multi-level maps); smokes/flashes detonate in the air
                        let dz = (p[2] - pos[2]).abs();
                        let dz_pen = if pos[2] > p[2] { (dz - 200.0).max(0.0) } else { dz };
                        let d = ((p[0] - pos[0]).powi(2) + (p[1] - pos[1]).powi(2)).sqrt() + dz_pen * 1.5;
                        if d < 420.0 && best.map(|b| d < b.0).unwrap_or(true) {
                            best = Some((d, *pl));
                        }
                    }
                }
            }
        }
        best.and_then(|(_, pl)| fs.place_name(pl))
    }
}

pub fn throw_style(ev: &Ev) -> String {
    let vx = ev.f32("user_velocity_X").unwrap_or(0.0);
    let vy = ev.f32("user_velocity_Y").unwrap_or(0.0);
    let vz = ev.f32("user_velocity_Z").unwrap_or(0.0);
    let speed = (vx * vx + vy * vy).sqrt();
    let airborne = ev.bool("user_is_airborne").unwrap_or(false);
    let duck = ev.f32("user_duck_amount").unwrap_or(0.0);
    let walking = ev.bool("user_is_walking").unwrap_or(false);
    if airborne || vz.abs() > 60.0 {
        "jump".into()
    } else if duck > 0.5 {
        "crouch".into()
    } else if speed > 150.0 {
        "run".into()
    } else if speed > 15.0 || walking && speed > 5.0 {
        "walk".into()
    } else {
        "stand".into()
    }
}

fn detect_source(header: &HashMap<String, String>, clan_names: &[String]) -> String {
    let sn = header.get("server_name").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    if sn.contains("faceit") {
        return "faceit".into();
    }
    if sn.contains("esea") {
        return "esea".into();
    }
    if sn.contains("valve") {
        return "valve".into();
    }
    let real_clans = clan_names.iter().filter(|c| !c.is_empty() && !c.starts_with("team_")).count();
    if real_clans >= 2 {
        return "hltv".into();
    }
    "unknown".into()
}

pub fn build(raw: RawDemo, file_name: &str, progress: &(dyn Fn(&str, f32) + Sync)) -> crate::error::Result<Built> {
    let RawDemo { header, events, ticks, tick_stride, projectiles, voice: voice_packets, .. } = raw;
    let rawf = build_raw_frames(&ticks, tick_stride);
    drop(ticks);
    progress("rounds", 0.75);
    let last_event_tick = events.iter().map(|e| e.tick).max().unwrap_or(0);
    let last_tick = rawf.last_tick.max(last_event_tick).max(0);
    let drafts = detect_rounds(&events, &rawf, last_tick);

    // ---- players ----------------------------------------------------------------------------
    let frame_of = |tick: i32| -> Option<usize> {
        if rawf.frame_count == 0 || tick < rawf.start_tick {
            None
        } else {
            Some((((tick - rawf.start_tick) / rawf.interval) as usize).min(rawf.frame_count - 1))
        }
    };
    // side of each key per round (sampled a bit after freeze end)
    let mut key_sides: Vec<HashMap<PlayerKey, Side>> = vec![];
    for d in &drafts {
        let mut m = HashMap::new();
        let probe_ticks = [d.freeze_end + 16, (d.freeze_end + d.end) / 2, d.end - 4];
        for (k, v) in &rawf.by_key {
            for &pt in &probe_ticks {
                if let Some(f) = frame_of(pt) {
                    let s = &v[f];
                    if s.present {
                        if let Some(side) = Side::from_team_num(s.team as i64) {
                            m.insert(k.clone(), side);
                            break;
                        }
                    }
                }
            }
        }
        key_sides.push(m);
    }
    // keys that took part in real rounds (or anywhere, if no rounds were detected)
    let mut participants: HashSet<PlayerKey> = HashSet::new();
    for m in &key_sides {
        participants.extend(m.keys().cloned());
    }
    if drafts.is_empty() {
        for (k, v) in &rawf.by_key {
            if v.iter().any(|s| s.present && (s.team == 2 || s.team == 3)) {
                participants.insert(k.clone());
            }
        }
    }
    // drop keys that never moved / never were alive in rounds (coaches parked as spectators etc.)
    participants.retain(|k| rawf.by_key.get(k).map(|v| v.iter().any(|s| s.alive())).unwrap_or(false));
    // coaches (controller flagged as coaching) and "ghosts" that never fired, hurt or got hurt
    let mut active: HashSet<PlayerKey> = HashSet::new();
    for e in events.iter().filter(|e| matches!(e.name.as_str(), "weapon_fire" | "player_hurt" | "player_death")) {
        for pre in ["user", "attacker"] {
            if let Some(k) = PlayerKey::new(e.steamid(pre), e.pname(pre)) {
                active.insert(k);
            }
        }
    }
    participants.retain(|k| {
        let rows = rawf.by_key.get(k).map(|v| v.iter().filter(|s| s.present).count()).unwrap_or(0).max(1);
        let coach = rawf.coach_rows.get(k).copied().unwrap_or(0);
        coach * 2 < rows && (active.is_empty() || active.contains(k))
    });

    // constant team assignment: team 0 = side CT in the first round
    let mut team_of: HashMap<PlayerKey, u8> = HashMap::new();
    let mut team0_side: Vec<Side> = vec![];
    for (ri, m) in key_sides.iter().enumerate() {
        let mut votes = [0i32; 2]; // votes for team0 being CT / T
        for (k, side) in m {
            if let Some(&t) = team_of.get(k) {
                let t0_side = if t == 0 { *side } else { side.other() };
                if t0_side == Side::CT {
                    votes[0] += 1
                } else {
                    votes[1] += 1
                }
            }
        }
        let side0 = if ri == 0 || votes == [0, 0] {
            if ri == 0 { Side::CT } else { team0_side[ri - 1] }
        } else if votes[0] >= votes[1] {
            Side::CT
        } else {
            Side::T
        };
        team0_side.push(side0);
        for (k, side) in m {
            team_of.entry(k.clone()).or_insert(if *side == side0 { 0 } else { 1 });
        }
    }
    for k in &participants {
        if !team_of.contains_key(k) {
            let v = &rawf.by_key[k];
            let first_team = v.iter().find(|s| s.present && (s.team == 2 || s.team == 3)).map(|s| s.team).unwrap_or(3);
            team_of.insert(k.clone(), if first_team == 3 { 0 } else { 1 });
        }
    }
    let mut keys: Vec<PlayerKey> = participants.into_iter().collect();
    let name_of = |k: &PlayerKey| rawf.names.get(k).cloned().unwrap_or_else(|| match k {
        PlayerKey::Steam(s) => s.to_string(),
        PlayerKey::Bot(n) => n.clone(),
    });
    keys.sort_by(|a, b| {
        team_of[a].cmp(&team_of[b]).then_with(|| name_of(a).to_lowercase().cmp(&name_of(b).to_lowercase()))
    });
    // team names: most common clan name among the team's players (first half counts most)
    let mut team_clans: [HashMap<String, usize>; 2] = [HashMap::new(), HashMap::new()];
    let mut clan_list = vec![];
    for k in &keys {
        if let Some(cm) = rawf.clan.get(k) {
            // clan name follows the *team entity* (side), so only trust it when it agrees with team_of
            if let Some((name, _)) = cm.iter().max_by_key(|(_, c)| **c) {
                *team_clans[team_of[k] as usize].entry(name.clone()).or_default() += 1;
            }
        }
    }
    let mut team_names = [String::new(), String::new()];
    for t in 0..2 {
        if let Some((n, _)) = team_clans[t].iter().max_by_key(|(_, c)| **c) {
            team_names[t] = n.clone();
            clan_list.push(n.clone());
        }
    }
    if team_names[0] == team_names[1] {
        team_names = [String::new(), String::new()];
    }
    for (t, n) in team_names.iter_mut().enumerate() {
        if n.is_empty() {
            *n = if t == 0 { "Takım A".into() } else { "Takım B".into() };
        }
    }
    let mut bot_counter = 0u64;
    let players: Vec<PlayerInfo> = keys
        .iter()
        .enumerate()
        .map(|(slot, k)| {
            let (steam_id, is_bot) = match k {
                PlayerKey::Steam(s) => (s.to_string(), false),
                PlayerKey::Bot(_) => {
                    bot_counter += 1;
                    (format!("{}", 90_000 + bot_counter), true)
                }
            };
            PlayerInfo { slot, steam_id, name: name_of(k), team: team_of[k], team_name: team_names[team_of[k] as usize].clone(), is_bot }
        })
        .collect();
    let mut by_key = HashMap::new();
    let mut by_name = HashMap::new();
    for (i, k) in keys.iter().enumerate() {
        by_key.insert(k.clone(), i);
        by_name.insert(name_of(k), i);
    }
    let slots = SlotMap { by_key, by_name };
    let np = players.len();

    // ---- frame store ---------------------------------------------------------------------------
    let mut by_key_frames = rawf.by_key;
    let samples: Vec<Vec<Sample>> = keys.iter().map(|k| by_key_frames.remove(k).unwrap_or_default()).collect();
    let mut fs = FrameStore {
        start_tick: rawf.start_tick,
        interval: rawf.interval,
        frame_count: rawf.frame_count,
        samples,
        rules: rawf.rules,
        places: rawf.places,
        weapons: rawf.weapons,
    };
    drop(by_key_frames);

    // ---- rounds --------------------------------------------------------------------------------
    let round_of_tick = |tick: i32| -> Option<u32> {
        // a round "owns" [start, next.start)
        let mut found = None;
        for (i, d) in drafts.iter().enumerate() {
            let next = drafts.get(i + 1).map(|n| n.start).unwrap_or(i32::MAX);
            if tick >= d.start && tick < next && tick <= d.official_end.max(d.end) + 64 * 2 {
                found = Some(i as u32 + 1);
                break;
            }
        }
        found
    };
    let mut round_sides: Vec<Vec<Option<Side>>> = vec![];
    for (ri, m) in key_sides.iter().enumerate() {
        let mut v = vec![None; np];
        for (k, s) in m {
            if let Some(&slot) = slots.by_key.get(k) {
                v[slot] = Some(*s);
            }
        }
        // players present but missing at probe ticks: use team identity
        for (slot, p) in players.iter().enumerate() {
            if v[slot].is_none() {
                let f = fs.frame_at(drafts[ri].freeze_end + 16);
                if let Some(f) = f {
                    if fs.samples[slot][f].present && fs.samples[slot][f].team >= 2 {
                        v[slot] = Some(if p.team == 0 { team0_side[ri] } else { team0_side[ri].other() });
                    }
                }
            }
        }
        round_sides.push(v);
    }

    // initial score (demo may start mid-match)
    let mut score = [0u32; 2];
    if let Some(d0) = drafts.first() {
        if let Some(r) = fs.rules_at(d0.freeze_end + 8) {
            let side0 = team0_side[0];
            let (s0, s1) = if side0 == Side::CT { (r.score_ct, r.score_t) } else { (r.score_t, r.score_ct) };
            if s0 >= 0 && s1 >= 0 && s0 + s1 <= r.rounds_played.max(0) {
                score = [s0 as u32, s1 as u32];
            }
        }
    }

    let bomb_evs: Vec<&Ev> = events.iter().filter(|e| e.name.starts_with("bomb_")).collect();
    // bomb site id -> A/B
    let mut site_votes: HashMap<i64, [i32; 2]> = HashMap::new();
    for e in &bomb_evs {
        if let (Some(site), Some(place)) = (e.int("site"), e.str("user_last_place_name")) {
            let p = place.to_ascii_lowercase();
            let v = site_votes.entry(site).or_default();
            if p.contains("bombsitea") || p == "a" || p.ends_with("sitea") {
                v[0] += 1;
            } else if p.contains("bombsiteb") || p == "b" || p.ends_with("siteb") {
                v[1] += 1;
            }
        }
    }
    let mut site_map: HashMap<i64, String> = HashMap::new();
    for (k, v) in &site_votes {
        if v[0] > v[1] {
            site_map.insert(*k, "A".into());
        } else if v[1] > v[0] {
            site_map.insert(*k, "B".into());
        }
    }
    let known: Vec<(i64, String)> = site_map.iter().map(|(a, b)| (*a, b.clone())).collect();
    if known.len() == 1 {
        for k in site_votes.keys() {
            if !site_map.contains_key(k) {
                site_map.insert(*k, if known[0].1 == "A" { "B".into() } else { "A".into() });
            }
        }
    }
    let site_of = |e: &Ev| -> Option<String> {
        e.int("site").and_then(|s| site_map.get(&s).cloned()).or_else(|| {
            let p = e.str("user_last_place_name")?.to_ascii_lowercase();
            if p.contains("bombsitea") {
                Some("A".into())
            } else if p.contains("bombsiteb") {
                Some("B".into())
            } else {
                None
            }
        })
    };

    let mut rounds: Vec<RoundInfo> = vec![];
    let mut prev_sides: Option<[Side; 2]> = None;
    for (ri, d) in drafts.iter().enumerate() {
        let sides = [team0_side[ri], team0_side[ri].other()];
        let number = ri as u32 + 1;
        // equipment at freeze end
        let mut equip = [0i32; 2];
        let mut money_start = [0i32; 2];
        let mut cnt = [0i32; 2];
        for (slot, p) in players.iter().enumerate() {
            if round_sides[ri][slot].is_none() {
                continue;
            }
            if let Some(s) = fs.sample(slot, d.freeze_end + 8) {
                equip[p.team as usize] += s.equip;
                cnt[p.team as usize] += 1;
            }
            if let Some(s) = fs.sample(slot, d.start + 8) {
                money_start[p.team as usize] += s.money + s.equip;
            }
        }
        let swapped = prev_sides.map(|ps| ps != sides).unwrap_or(true);
        let buy_types: [String; 2] = std::array::from_fn(|t| {
            let n = cnt[t].max(1);
            let avg = equip[t] / n;
            let avg_start = money_start[t] / n;
            if swapped && avg_start <= 1100 && avg <= 1100 {
                "pistol".to_string()
            } else if avg < 1250 {
                "eco".to_string()
            } else if avg < 3600 {
                "force".to_string()
            } else {
                "full".to_string()
            }
        });
        prev_sides = Some(sides);
        let planted = bomb_evs.iter().find(|e| e.name == "bomb_planted" && e.tick >= d.freeze_end && e.tick <= d.end);
        let info = RoundInfo {
            number,
            start_tick: d.start,
            freeze_end_tick: d.freeze_end,
            end_tick: d.end,
            official_end_tick: d.official_end,
            winner: d.winner,
            end_reason: d.reason.clone(),
            team_sides: sides,
            score_before: score,
            buy_types,
            equip_values: equip,
            bomb_planted_tick: planted.map(|e| e.tick),
            bomb_site: planted.and_then(|e| site_of(e)),
        };
        if let Some(w) = d.winner {
            let wt = if sides[0] == w { 0 } else { 1 };
            score[wt] += 1;
        }
        rounds.push(info);
    }
    let final_score_from_game = drafts.last().and_then(|d| {
        let r = fs.rules_at(d.official_end.max(d.end + 64))?;
        let last = rounds.last()?;
        // after the last round the score reflects the result; sides as in the last round
        let s0 = if last.team_sides[0] == Side::CT { r.score_ct } else { r.score_t };
        let s1 = if last.team_sides[0] == Side::CT { r.score_t } else { r.score_ct };
        if s0 + s1 > 0 {
            Some([s0.max(0) as u32, s1.max(0) as u32])
        } else {
            None
        }
    });

    let side_of_slot = |slot: usize, round: Option<u32>, tick: i32| -> Option<Side> {
        if let Some(r) = round {
            if let Some(s) = round_sides.get(r as usize - 1).and_then(|v| v[slot]) {
                return Some(s);
            }
        }
        fs.sample(slot, tick).and_then(|s| Side::from_team_num(s.team as i64))
    };

    // ---- kills / damage / shots ---------------------------------------------------------------
    progress("events", 0.8);
    let mut kills: Vec<KillEvent> = vec![];
    let mut deaths: Vec<DeathCtx> = vec![];
    let mut damages: Vec<DamageEvent> = vec![];
    let mut shots: Vec<ShotEvent> = vec![];
    let mut reloads = vec![];
    let mut purchases = vec![];
    let mut hp: Vec<i32> = vec![100; np];
    let mut hp_round: Vec<u32> = vec![0; np];
    let mut chat = vec![];
    let mut bomb_events: Vec<BombEvent> = vec![];
    let mut blinds_raw: Vec<(i32, u32, usize, usize, f32, Option<i32>)> = vec![];
    let mut throws: Vec<&Ev> = vec![];
    let mut detonations: Vec<&Ev> = vec![];

    for e in &events {
        let round = round_of_tick(e.tick);
        match e.name.as_str() {
            "player_death" => {
                let Some(r) = round else { continue };
                let Some(victim) = slots.of(e, "user") else { continue };
                let mut attacker = slots.of(e, "attacker");
                if attacker == Some(victim) {
                    attacker = None;
                }
                let assister = slots.of(e, "assister").filter(|a| Some(*a) != attacker && *a != victim);
                let weapon = normalize_weapon(e.str("weapon").unwrap_or("world"));
                let victim_pos = e.pos("user").or_else(|| fs.sample(victim, e.tick).map(|s| s.pos)).unwrap_or([0.0; 3]);
                let attacker_pos = attacker.and_then(|_| e.pos("attacker"));
                let distance = attacker_pos.map(|a| dist(a, victim_pos)).unwrap_or(0.0);
                kills.push(KillEvent {
                    tick: e.tick,
                    round: r,
                    attacker,
                    victim,
                    assister,
                    flash_assist: e.bool("assistedflash").unwrap_or(false),
                    weapon: if weapon.is_empty() { "world".into() } else { weapon },
                    headshot: e.bool("headshot").unwrap_or(false),
                    wallbang: e.int("penetrated").unwrap_or(0) > 0,
                    through_smoke: e.bool("thrusmoke").unwrap_or(false),
                    no_scope: e.bool("noscope").unwrap_or(false),
                    attacker_blind: e.bool("attackerblind").unwrap_or(false),
                    attacker_pos,
                    victim_pos,
                    distance,
                    is_opening: false,
                    is_trade: false,
                    victim_traded: false,
                });
                deaths.push(DeathCtx {
                    victim_inventory: e.str_vec("user_inventory").map(|v| v.iter().map(|s| normalize_weapon(s)).collect()).unwrap_or_default(),
                    victim_weapon: normalize_weapon(e.str("user_active_weapon_name").unwrap_or("")),
                    victim_yaw: e.f32("user_yaw"),
                    attacker_yaw: e.f32("attacker_yaw"),
                    victim_place: e.str("user_last_place_name").filter(|s| !s.is_empty()).map(|s| s.to_string()),
                    attacker_place: e.str("attacker_last_place_name").filter(|s| !s.is_empty()).map(|s| s.to_string()),
                    attacker_health: e.int("attacker_health").map(|h| h as i32),
                });
                hp[victim] = 0;
            }
            "player_hurt" => {
                let Some(r) = round else { continue };
                let Some(victim) = slots.of(e, "user") else { continue };
                let mut attacker = slots.of(e, "attacker");
                if attacker == Some(victim) {
                    attacker = None;
                }
                if hp_round[victim] != r {
                    hp_round[victim] = r;
                    hp[victim] = 100;
                }
                let dmg = e.int("dmg_health").unwrap_or(0).max(0) as i32;
                let after = e.int("health").map(|h| h.max(0) as i32);
                let before = hp[victim];
                let capped = match after {
                    Some(a) if before >= a && before - a <= dmg => before - a,
                    _ => dmg.min(before.max(0)),
                };
                if let Some(a) = after {
                    hp[victim] = a;
                } else {
                    hp[victim] = (before - capped).max(0);
                }
                damages.push(DamageEvent {
                    tick: e.tick,
                    round: r,
                    attacker,
                    victim,
                    weapon: normalize_weapon(e.str("weapon").unwrap_or("world")),
                    hp_damage: capped,
                    armor_damage: e.int("dmg_armor").unwrap_or(0).max(0) as i32,
                    hitgroup: hitgroup(e.str("hitgroup").unwrap_or("generic")),
                });
            }
            "weapon_fire" => {
                let Some(p) = slots.of(e, "user") else { continue };
                let w = normalize_weapon(e.str("weapon").unwrap_or(""));
                if is_grenade_weapon(&w) {
                    throws.push(e);
                } else if is_firearm(&w) && round.is_some() {
                    shots.push(ShotEvent { tick: e.tick, player: p, weapon: w });
                }
            }
            "weapon_reload" => {
                if let Some(p) = slots.of(e, "user") {
                    reloads.push((e.tick, p));
                }
            }
            "item_purchase" => {
                let Some(r) = round else { continue };
                let p = e
                    .f
                    .get("steamid")
                    .and_then(crate::extract::variant_num)
                    .and_then(|s| slots.of_steam(s as u64))
                    .or_else(|| e.str("name").and_then(|n| slots.by_name.get(n).copied()));
                if let Some(p) = p {
                    if !e.bool("was_sold").unwrap_or(false) {
                        purchases.push(Purchase {
                            tick: e.tick,
                            round: r,
                            slot: p,
                            item: e.str("item_name").unwrap_or("").to_string(),
                            cost: e.int("cost").unwrap_or(0) as i32,
                        });
                    }
                }
            }
            "chat_message" => {
                let text = e.str("chat_message").or_else(|| e.str("text")).unwrap_or("").to_string();
                if !text.is_empty() {
                    chat.push(ChatMessage { tick: e.tick, player: slots.of(e, "user"), text, team_only: false });
                }
            }
            "player_blind" => {
                let (Some(r), Some(victim), Some(att)) = (round, slots.of(e, "user"), slots.of(e, "attacker")) else { continue };
                let dur = e.f32("blind_duration").unwrap_or(0.0);
                // spectators / dead players receive blind events too
                let alive = fs.sample(victim, e.tick).map(|s| s.alive()).unwrap_or(false) || e.int("user_health").unwrap_or(0) > 0;
                if dur <= 0.0 || !alive {
                    continue;
                }
                blinds_raw.push((e.tick, r, att, victim, dur, e.int("entityid").map(|x| x as i32)));
            }
            "flashbang_detonate" | "hegrenade_detonate" | "smokegrenade_detonate" | "inferno_startburn" | "decoy_started" | "decoy_detonate" | "smokegrenade_expired" | "inferno_expire" => {
                detonations.push(e);
            }
            n if n.starts_with("bomb_") => {
                let Some(r) = round else { continue };
                let kind = match n {
                    "bomb_pickup" => "pickup",
                    "bomb_dropped" => "drop",
                    "bomb_beginplant" => "plant_begin",
                    "bomb_planted" => "planted",
                    "bomb_begindefuse" => "defuse_begin",
                    "bomb_abortdefuse" => "defuse_abort",
                    "bomb_defused" => "defused",
                    "bomb_exploded" => "exploded",
                    "bomb_abortplant" => "plant_abort",
                    _ => continue,
                };
                bomb_events.push(BombEvent {
                    tick: e.tick,
                    round: r,
                    kind: kind.into(),
                    player: slots.of(e, "user"),
                    site: if matches!(kind, "plant_begin" | "planted" | "defuse_begin" | "defused" | "exploded" | "defuse_abort" | "plant_abort") { site_of(e) } else { None },
                    pos: e.pos("user"),
                });
            }
            _ => {}
        }
    }
    let _ = &side_of_slot;

    // ---- grenades ------------------------------------------------------------------------------
    progress("grenades", 0.85);
    let mut runs = projectile_runs(&projectiles);
    drop(projectiles);
    let place_index = PlaceIndex::build(&fs);
    let mut grenades: Vec<Grenade> = vec![];
    let mut det_used: Vec<bool> = vec![false; detonations.len()];
    for th in &throws {
        let Some(thrower) = slots.of(th, "user") else { continue };
        let Some(round) = round_of_tick(th.tick) else { continue };
        let w = normalize_weapon(th.str("weapon").unwrap_or(""));
        let Some(kind) = grenade_type_of_weapon(&w) else { continue };
        let sid = match &keys[thrower] {
            PlayerKey::Steam(s) => Some(*s),
            _ => None,
        };
        let tname = players[thrower].name.clone();
        // projectile: same thrower/type, appearing shortly after the throw
        let mut best: Option<usize> = None;
        for (i, r) in runs.iter().enumerate() {
            if r.used || r.kind != kind {
                continue;
            }
            let first = r.pts[0].0;
            if first < th.tick - 2 {
                continue;
            }
            if first > th.tick + 48 {
                break;
            }
            let same = match (sid, r.thrower) {
                (Some(a), Some(b)) => a == b,
                _ => r.thrower_name.as_deref() == Some(tname.as_str()),
            };
            if same {
                best = Some(i);
                break;
            }
        }
        let throw_pos = th.pos("user").unwrap_or([0.0; 3]);
        let mut g = Grenade {
            id: grenades.len() as u32,
            kind,
            thrower,
            round,
            throw_tick: th.tick,
            throw_pos,
            throw_yaw: th.f32("user_yaw").unwrap_or(0.0),
            throw_pitch: th.f32("user_pitch").unwrap_or(0.0),
            throw_style: throw_style(th),
            detonate_tick: None,
            detonate_pos: None,
            expire_tick: None,
            trajectory: vec![],
            land_place: None,
            throw_place: th.str("user_last_place_name").filter(|s| !s.is_empty()).map(|s| s.to_string()),
            enemies_flashed: 0,
            teammates_flashed: 0,
            enemy_blind_seconds: 0.0,
            team_blind_seconds: 0.0,
            damage: 0,
            team_damage: 0,
        };
        let mut eid: Option<i32> = None;
        let mut run_pts: Vec<(i32, Vec3)> = vec![];
        if let Some(i) = best {
            runs[i].used = true;
            eid = Some(runs[i].eid);
            run_pts = runs[i].pts.clone();
        }
        // detonation
        let det_name = match kind {
            GrenadeType::Smoke => "smokegrenade_detonate",
            GrenadeType::Flash => "flashbang_detonate",
            GrenadeType::He => "hegrenade_detonate",
            GrenadeType::Molotov => "inferno_startburn",
            GrenadeType::Decoy => "decoy_started",
        };
        let run_end = run_pts.last().copied();
        let mut det_idx: Option<usize> = None;
        let horizon = th.tick + 64 * 25;
        let mut best_score = f32::MAX;
        for (i, d) in detonations.iter().enumerate() {
            if det_used[i] || d.name != det_name || d.tick < th.tick || d.tick > horizon {
                continue;
            }
            let same_thrower = slots.of(d, "user") == Some(thrower);
            let dpos = [d.f32("x").unwrap_or(0.0), d.f32("y").unwrap_or(0.0), d.f32("z").unwrap_or(0.0)];
            let score = match (kind, eid, run_end) {
                (GrenadeType::Molotov, _, Some((rt, rp))) => {
                    let dd = dist(dpos, rp);
                    if (d.tick - rt).abs() > 32 || dd > 300.0 {
                        continue;
                    }
                    dd + (d.tick - rt).abs() as f32
                }
                (_, Some(id), _) if d.int("entityid") == Some(id as i64) => (d.tick - th.tick) as f32 * 0.01,
                _ => {
                    if !same_thrower {
                        continue;
                    }
                    1000.0 + (d.tick - th.tick) as f32
                }
            };
            if score < best_score {
                best_score = score;
                det_idx = Some(i);
            }
            if score < 1.0 {
                break;
            }
        }
        if let Some(i) = det_idx {
            det_used[i] = true;
            let d = detonations[i];
            g.detonate_tick = Some(d.tick);
            let dpos = [d.f32("x").unwrap_or(0.0), d.f32("y").unwrap_or(0.0), d.f32("z").unwrap_or(0.0)];
            g.detonate_pos = Some(dpos);
            // expiry
            let exp_name = match kind {
                GrenadeType::Smoke => Some("smokegrenade_expired"),
                GrenadeType::Molotov => Some("inferno_expire"),
                GrenadeType::Decoy => Some("decoy_detonate"),
                _ => None,
            };
            if let Some(en) = exp_name {
                let did = d.int("entityid");
                for (j, x) in detonations.iter().enumerate() {
                    if !det_used[j] && x.name == en && x.tick >= d.tick && x.tick < d.tick + 64 * 30 && x.int("entityid") == did {
                        det_used[j] = true;
                        g.expire_tick = Some(x.tick);
                        break;
                    }
                }
                if kind == GrenadeType::Smoke && g.expire_tick.is_none() {
                    g.expire_tick = Some(d.tick + (18.0 * TICK_RATE) as i32);
                }
                if kind == GrenadeType::Molotov && g.expire_tick.is_none() {
                    g.expire_tick = Some(d.tick + (7.0 * TICK_RATE) as i32);
                }
            }
            if matches!(kind, GrenadeType::Flash | GrenadeType::He) {
                g.expire_tick = None;
            }
        }
        // trajectory: until detonation, every 2nd tick (+ endpoints)
        let stop = g.detonate_tick.unwrap_or(i32::MAX);
        let mut traj: Vec<f32> = vec![];
        traj.extend_from_slice(&[th.tick as f32, throw_pos[0], throw_pos[1], throw_pos[2] + 56.0]);
        let pts: Vec<&(i32, Vec3)> = run_pts.iter().filter(|(t, _)| *t <= stop).collect();
        for (i, (t, p)) in pts.iter().enumerate() {
            if i % 2 == 0 || i + 1 == pts.len() {
                traj.extend_from_slice(&[*t as f32, p[0], p[1], p[2]]);
            }
        }
        if let (Some(dt), Some(dp)) = (g.detonate_tick, g.detonate_pos) {
            if traj.len() < 8 || traj[traj.len() - 4] < dt as f32 {
                traj.extend_from_slice(&[dt as f32, dp[0], dp[1], dp[2]]);
            }
        }
        g.trajectory = traj;
        if g.detonate_pos.is_none() {
            if let Some((_, p)) = run_pts.last() {
                g.detonate_pos = None;
                let _ = p;
            }
        }
        let landing = g.detonate_pos.or_else(|| run_pts.last().map(|(_, p)| *p));
        g.land_place = landing.and_then(|p| place_index.lookup(&fs, p)).map(|s| s.to_string());
        grenades.push(g);
    }

    // flash links: blind events -> grenade by entity id, else by thrower + time
    let mut blinds: Vec<BlindEvent> = vec![];
    for (tick, round, att, victim, dur, eid) in blinds_raw {
        let gid = grenades
            .iter()
            .filter(|g| g.kind == GrenadeType::Flash && g.thrower == att && g.detonate_tick.map(|d| (d - tick).abs() <= 2).unwrap_or(false))
            .map(|g| g.id)
            .next()
            .or_else(|| {
                let _ = eid;
                grenades
                    .iter()
                    .filter(|g| g.kind == GrenadeType::Flash && g.thrower == att && g.throw_tick <= tick && tick - g.throw_tick < 64 * 4)
                    .map(|g| g.id)
                    .last()
            });
        let sa = side_of_slot(att, Some(round), tick);
        let sv = side_of_slot(victim, Some(round), tick);
        let team_flash = sa.is_some() && sa == sv;
        blinds.push(BlindEvent { tick, round, attacker: att, victim, duration: dur, team_flash, grenade_id: gid });
        if let Some(g) = gid.and_then(|id| grenades.get_mut(id as usize)) {
            if team_flash {
                if victim != att {
                    g.teammates_flashed += 1;
                    g.team_blind_seconds += dur;
                }
            } else {
                g.enemies_flashed += 1;
                g.enemy_blind_seconds += dur;
            }
        }
    }
    // utility damage
    for d in &damages {
        let Some(att) = d.attacker else { continue };
        let kind = match d.weapon.as_str() {
            "hegrenade" => GrenadeType::He,
            "inferno" | "molotov" | "incgrenade" => GrenadeType::Molotov,
            _ => continue,
        };
        let team = side_of_slot(att, Some(d.round), d.tick) == side_of_slot(d.victim, Some(d.round), d.tick);
        let cand = grenades
            .iter_mut()
            .filter(|g| g.kind == kind && g.thrower == att)
            .filter(|g| match (g.detonate_tick, kind) {
                (Some(dt), GrenadeType::He) => (d.tick - dt).abs() <= 4,
                (Some(dt), _) => d.tick >= dt && d.tick <= g.expire_tick.unwrap_or(dt + 7 * 64) + 16,
                _ => false,
            })
            .last();
        if let Some(g) = cand {
            if team {
                g.team_damage += d.hp_damage;
            } else {
                g.damage += d.hp_damage;
            }
        }
    }

    // ---- frames: bomb carrier / planting / flash remaining --------------------------------------
    progress("frames", 0.9);
    {
        // bomb carrier intervals; a drop/plant by a player whose pickup we never saw (bomb given at
        // spawn after a restart) is back-filled to the start of that carry.
        let mut carrier_iv: Vec<(i32, i32, usize)> = vec![];
        for (ri, r) in rounds.iter().enumerate() {
            let next = rounds.get(ri + 1).map(|n| n.start_tick).unwrap_or(i32::MAX);
            let mut cur: Option<(usize, i32)> = None;
            let mut free_since = r.start_tick;
            for b in bomb_events.iter().filter(|b| b.tick >= r.start_tick && b.tick < next) {
                match (b.kind.as_str(), b.player) {
                    ("pickup", Some(p)) => {
                        if let Some((c, st)) = cur.take() {
                            carrier_iv.push((st, b.tick, c));
                        }
                        cur = Some((p, b.tick));
                    }
                    ("drop" | "planted" | "plant_begin", Some(p)) => {
                        let start = match cur {
                            Some((c, st)) if c == p => st,
                            _ => free_since,
                        };
                        if b.kind == "plant_begin" {
                            cur = Some((p, start));
                        } else {
                            carrier_iv.push((start, b.tick, p));
                            cur = None;
                            free_since = b.tick;
                        }
                    }
                    _ => {}
                }
            }
            if let Some((c, st)) = cur {
                carrier_iv.push((st, next.min(r.official_end_tick.max(r.end_tick) + 64), c));
            }
        }
        carrier_iv.sort();
        let mut carrier: Option<usize>;
        let mut planting: Option<usize> = None;
        let mut bi = 0usize;
        let bevs: Vec<&BombEvent> = bomb_events.iter().collect();
        let mut flash_until: Vec<(i32, f32)> = vec![(i32::MIN, 0.0); np]; // (start tick, duration)
        let mut blind_i = 0usize;
        let mut sorted_blinds: Vec<&BlindEvent> = blinds.iter().collect();
        sorted_blinds.sort_by_key(|b| b.tick);
        let mut round_i = 0usize;
        for f in 0..fs.frame_count {
            let tick = fs.tick_of(f);
            while round_i < rounds.len() && rounds[round_i].start_tick <= tick {
                planting = None;
                round_i += 1;
            }
            carrier = carrier_iv.iter().find(|(a, b, _)| *a <= tick && tick < *b).map(|x| x.2);
            while bi < bevs.len() && bevs[bi].tick <= tick {
                let b = bevs[bi];
                match b.kind.as_str() {
                    "drop" | "planted" => planting = None,
                    "plant_begin" => planting = b.player,
                    "plant_abort" => planting = None,
                    _ => {}
                }
                bi += 1;
            }
            while blind_i < sorted_blinds.len() && sorted_blinds[blind_i].tick <= tick {
                let b = sorted_blinds[blind_i];
                let (st, du) = flash_until[b.victim];
                let rem_old = if st == i32::MIN { 0.0 } else { du - (b.tick as i64 - st as i64) as f32 / TICK_RATE };
                if b.duration > rem_old {
                    flash_until[b.victim] = (b.tick, b.duration);
                }
                blind_i += 1;
            }
            for slot in 0..np {
                let s = &mut fs.samples[slot][f];
                if !s.present {
                    continue;
                }
                s.flags &= !(frame_flag::HAS_BOMB | frame_flag::PLANTING);
                if carrier == Some(slot) && s.alive() {
                    s.flags |= frame_flag::HAS_BOMB;
                }
                if planting == Some(slot) && s.alive() {
                    s.flags |= frame_flag::PLANTING;
                }
                let (st, du) = flash_until[slot];
                let rem = if st == i32::MIN { 0.0 } else { (du - (tick - st) as f32 / TICK_RATE).max(0.0) };
                s.flash_dur = if s.alive() { rem } else { 0.0 };
            }
        }
        // walking flag: moving slowly (silent) or holding walk while moving
        for slot in 0..np {
            for f in 1..fs.frame_count {
                let (a, b) = (fs.samples[slot][f - 1], fs.samples[slot][f]);
                if !b.present {
                    continue;
                }
                let dt = fs.interval as f32 / TICK_RATE;
                let sp = (((b.pos[0] - a.pos[0]).powi(2) + (b.pos[1] - a.pos[1]).powi(2)).sqrt()) / dt;
                let walk_key = b.flags & frame_flag::WALKING != 0;
                let slow = sp > 10.0 && sp <= 140.0;
                let s = &mut fs.samples[slot][f];
                if b.alive() && (slow || (walk_key && sp > 5.0 && sp < 200.0)) && s.flags & frame_flag::AIRBORNE == 0 {
                    s.flags |= frame_flag::WALKING;
                } else {
                    s.flags &= !frame_flag::WALKING;
                }
            }
        }
    }

    bomb_events.retain(|b| b.kind != "plant_abort");

    // ---- voice --------------------------------------------------------------------------------
    progress("voice", 0.93);
    let slot_of_xuid = |x: u64| -> Option<(usize, String)> { slots.of_steam(x).map(|s| (s, players[s].steam_id.clone())) };
    let voice_store = voice::build(voice_packets, &slot_of_xuid, TICK_RATE);

    // ---- map / header -------------------------------------------------------------------------
    let mut bmin = [f32::MAX; 3];
    let mut bmax = [f32::MIN; 3];
    for v in &fs.samples {
        for s in v.iter().step_by(4) {
            if s.alive() {
                for k in 0..3 {
                    bmin[k] = bmin[k].min(s.pos[k]);
                    bmax[k] = bmax[k].max(s.pos[k]);
                }
            }
        }
    }
    if bmin[0] == f32::MAX {
        bmin = [0.0; 3];
        bmax = [0.0; 3];
    }
    let map_name = header.get("map_name").cloned().unwrap_or_else(|| "unknown".into());
    let map = maps::map_info(&map_name, bmin, bmax);
    let total_ticks = last_tick;
    let hdr = DemoHeader {
        file_name: file_name.to_string(),
        map_name: map_name.clone(),
        server_name: header.get("server_name").cloned().unwrap_or_default(),
        source: detect_source(&header, &clan_list),
        tick_rate: TICK_RATE,
        total_ticks,
        duration_seconds: total_ticks as f32 / TICK_RATE,
    };
    let frames_meta = FramesMeta {
        start_tick: fs.start_tick,
        sample_interval: fs.interval,
        frame_count: fs.frame_count,
        player_count: np,
        stride: FRAME_STRIDE,
        weapons: fs.weapons.clone(),
    };
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for g in &grenades {
        *counts.entry(g.kind.as_str().into()).or_default() += 1;
    }
    let data = DemoData {
        header: hdr,
        map,
        players,
        rounds,
        kills,
        damages,
        shots,
        blinds,
        grenades,
        bomb_events,
        chat,
        frames: frames_meta,
        voice: voice_store.info(),
        analysis: Analysis::default(),
    };
    Ok(Built {
        data,
        frames: fs,
        voice: voice_store,
        extra: Extra { deaths, reloads, purchases, final_score_from_game, round_sides },
    })
}
