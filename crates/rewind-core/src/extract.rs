//! Low-level extraction: runs the (vendored) demoparser in a few targeted passes and
//! converts its column output into simple typed records.

use crate::error::{Error, Result};
use ahash::AHashMap;
use cs2_demoparser::first_pass::parser_settings::{rm_user_friendly_names, ParserInputs};
use cs2_demoparser::parse_demo::{DemoOutput, Parser, ParsingMode};
use cs2_demoparser::second_pass::game_events::GameEvent;
use cs2_demoparser::second_pass::parser_settings::create_huffman_lookup_table;
use cs2_demoparser::second_pass::variants::{PropColumn, VarVec, Variant};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Game events we care about.
pub const WANTED_EVENTS: &[&str] = &[
    "player_death",
    "player_hurt",
    "weapon_fire",
    "weapon_reload",
    "player_blind",
    "flashbang_detonate",
    "hegrenade_detonate",
    "smokegrenade_detonate",
    "smokegrenade_expired",
    "inferno_startburn",
    "inferno_expire",
    "decoy_started",
    "decoy_detonate",
    "bomb_pickup",
    "bomb_dropped",
    "bomb_beginplant",
    "bomb_abortplant",
    "bomb_planted",
    "bomb_begindefuse",
    "bomb_abortdefuse",
    "bomb_defused",
    "bomb_exploded",
    "round_start",
    "round_end",
    "round_freeze_end",
    "round_officially_ended",
    "round_mvp",
    "begin_new_match",
    "round_announce_match_start",
    "cs_win_panel_match",
    "chat_message",
    "player_disconnect",
    "player_connect_full",
    "player_team",
    "item_purchase",
];

/// Player props attached to every event (prefixed `user_`, `attacker_`, `assister_`).
const EVENT_PLAYER_PROPS: &[&str] = &[
    "X",
    "Y",
    "Z",
    "pitch",
    "yaw",
    "last_place_name",
    "team_num",
    "health",
    "velocity_X",
    "velocity_Y",
    "velocity_Z",
    "is_airborne",
    "duck_amount",
    "is_walking",
    "is_scoped",
    "flash_duration",
    "active_weapon_name",
    "inventory",
];

/// Per-tick player props for frames + analysis.
pub const TICK_PROPS: &[&str] = &[
    "X",
    "Y",
    "Z",
    "yaw",
    "pitch",
    "health",
    "armor_value",
    "is_alive",
    "team_num",
    "duck_amount",
    "is_scoped",
    "is_defusing",
    "has_defuser",
    "has_helmet",
    "is_airborne",
    "is_walking",
    "flash_duration",
    "active_weapon_name",
    "balance",
    "current_equip_value",
    "is_connected",
    "last_place_name",
    "is_warmup_period",
    "is_freeze_period",
    "total_rounds_played",
    "team_rounds_total",
    "team_clan_name",
];

#[derive(Debug, Clone)]
pub struct Ev {
    pub name: String,
    pub tick: i32,
    pub f: AHashMap<String, Variant>,
}

pub fn variant_num(v: &Variant) -> Option<f64> {
    match v {
        Variant::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Variant::U32(x) => Some(*x as f64),
        Variant::I32(x) => Some(*x as f64),
        Variant::F32(x) => Some(*x as f64),
        Variant::U64(x) => Some(*x as f64),
        Variant::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

impl Ev {
    pub fn num(&self, k: &str) -> Option<f64> {
        self.f.get(k).and_then(variant_num)
    }
    pub fn int(&self, k: &str) -> Option<i64> {
        self.num(k).map(|x| x as i64)
    }
    pub fn f32(&self, k: &str) -> Option<f32> {
        self.num(k).map(|x| x as f32)
    }
    pub fn str(&self, k: &str) -> Option<&str> {
        match self.f.get(k) {
            Some(Variant::String(s)) => Some(s.as_str()),
            _ => None,
        }
    }
    pub fn bool(&self, k: &str) -> Option<bool> {
        match self.f.get(k) {
            Some(Variant::Bool(b)) => Some(*b),
            Some(v) => variant_num(v).map(|x| x != 0.0),
            None => None,
        }
    }
    pub fn str_vec(&self, k: &str) -> Option<&[String]> {
        match self.f.get(k) {
            Some(Variant::StringVec(v)) => Some(v.as_slice()),
            _ => None,
        }
    }
    /// steamid of a referenced player (prefix "user", "attacker", "assister").
    pub fn steamid(&self, prefix: &str) -> Option<u64> {
        match self.f.get(&format!("{prefix}_steamid")) {
            Some(Variant::String(s)) => s.parse::<u64>().ok(),
            Some(Variant::U64(x)) => Some(*x),
            _ => None,
        }
    }
    pub fn pname(&self, prefix: &str) -> Option<&str> {
        self.str(&format!("{prefix}_name"))
    }
    pub fn pos(&self, prefix: &str) -> Option<[f32; 3]> {
        let x = self.f32(&format!("{prefix}_X"))?;
        let y = self.f32(&format!("{prefix}_Y"))?;
        let z = self.f32(&format!("{prefix}_Z"))?;
        Some([x, y, z])
    }
}

/// Typed view of one parser column.
pub struct Column<'a> {
    col: &'a PropColumn,
}

impl<'a> Column<'a> {
    pub fn num(&self, row: usize) -> Option<f64> {
        match &self.col.data {
            Some(VarVec::F32(v)) => v.get(row).copied().flatten().map(|x| x as f64),
            Some(VarVec::I32(v)) => v.get(row).copied().flatten().map(|x| x as f64),
            Some(VarVec::U32(v)) => v.get(row).copied().flatten().map(|x| x as f64),
            Some(VarVec::U64(v)) => v.get(row).copied().flatten().map(|x| x as f64),
            Some(VarVec::Bool(v)) => v.get(row).copied().flatten().map(|x| if x { 1.0 } else { 0.0 }),
            _ => None,
        }
    }
    pub fn u64(&self, row: usize) -> Option<u64> {
        match &self.col.data {
            Some(VarVec::U64(v)) => v.get(row).copied().flatten(),
            _ => self.num(row).map(|x| x as u64),
        }
    }
    pub fn str(&self, row: usize) -> Option<&'a str> {
        match &self.col.data {
            Some(VarVec::String(v)) => v.get(row).and_then(|s| s.as_deref()),
            _ => None,
        }
    }
    pub fn len(&self) -> usize {
        self.col.len()
    }
}

pub struct Table {
    pub cols: HashMap<String, PropColumn>,
    pub rows: usize,
}

impl Table {
    fn from_output(out: &mut DemoOutput) -> Table {
        let mut cols = HashMap::new();
        let mut rows = 0;
        let infos = std::mem::take(&mut out.prop_controller.prop_infos);
        for pi in infos {
            if let Some(col) = out.df.remove(&pi.id) {
                rows = rows.max(col.len());
                cols.insert(pi.prop_friendly_name.clone(), col);
            }
        }
        Table { cols, rows }
    }
    pub fn col(&self, name: &str) -> Option<Column<'_>> {
        self.cols.get(name).map(|col| Column { col })
    }
}

#[derive(Debug, Clone)]
pub struct VoicePacket {
    pub tick: i32,
    pub xuid: u64,
    pub section: u32,
    pub data: Vec<u8>,
    pub sample_rate: u32,
    pub format: i32,
}

pub struct RawDemo {
    pub header: HashMap<String, String>,
    pub events: Vec<Ev>,
    pub ticks: Table,
    pub tick_stride: i32,
    pub tick_offset: i32,
    pub projectiles: Table,
    pub voice: Vec<VoicePacket>,
    pub convars: HashMap<String, String>,
    pub roster: Vec<(u64, String, i32)>,
}

fn make_inputs<'a>(
    huf: &'a Vec<(u8, u8)>,
    player_props: &[&str],
    events: &[&str],
    ticks: Vec<i32>,
    projectiles: bool,
) -> ParserInputs<'a> {
    let pprops: Vec<String> = player_props.iter().map(|s| s.to_string()).collect();
    let real = rm_user_friendly_names(&pprops).unwrap_or_else(|_| pprops.clone());
    let mut r2o = AHashMap::default();
    for (r, o) in real.iter().zip(&pprops) {
        r2o.insert(r.clone(), o.clone());
    }
    ParserInputs {
        real_name_to_og_name: r2o,
        wanted_players: vec![],
        wanted_player_props: real,
        wanted_other_props: vec![],
        wanted_prop_states: AHashMap::default(),
        wanted_ticks: ticks,
        wanted_events: events.iter().map(|s| s.to_string()).collect(),
        parse_ents: true,
        parse_projectiles: projectiles,
        parse_grenades: false,
        parse_weapons: false,
        only_header: false,
        list_props: false,
        only_convars: false,
        huffman_lookup_table: huf,
        order_by_steamid: false,
        fallback_bytes: None,
    }
}

/// Runs the parser, converting panics inside it into errors (malformed demos must not crash the app).
fn run_parser(bytes: &[u8], inputs: ParserInputs<'_>) -> Result<DemoOutput> {
    let res = catch_unwind(AssertUnwindSafe(|| {
        let mut p = Parser::new(inputs, ParsingMode::Normal);
        p.parse_demo(bytes)
    }));
    match res {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(Error::Parse(format!("{e:?}"))),
        Err(panic) => {
            let msg = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown".into());
            Err(Error::Parse(format!("parser panicked: {msg}")))
        }
    }
}

fn convert_events(evs: Vec<GameEvent>) -> Vec<Ev> {
    let mut out: Vec<Ev> = evs
        .into_iter()
        .map(|e| {
            let mut f = AHashMap::with_capacity(e.fields.len());
            for fld in e.fields {
                if let Some(d) = fld.data {
                    f.insert(fld.name, d);
                }
            }
            Ev { name: e.name, tick: e.tick, f }
        })
        .collect();
    out.sort_by_key(|e| e.tick);
    out
}

pub fn check_magic(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 16 {
        return Err(Error::NotADemo("file is too small".into()));
    }
    if &bytes[0..8] == b"HL2DEMO\0" {
        return Err(Error::NotADemo(
            "this is a CS:GO (Source 1) demo; only CS2 demos are supported".into(),
        ));
    }
    if &bytes[0..8] != b"PBDEMS2\0" {
        return Err(Error::NotADemo("missing PBDEMS2 header".into()));
    }
    Ok(())
}

pub const SAMPLE_INTERVAL: i32 = 4;

/// Parse everything we need. `progress(stage, pct)` is called from worker threads.
pub fn extract(bytes: &[u8], progress: &(dyn Fn(&str, f32) + Sync)) -> Result<RawDemo> {
    check_magic(bytes)?;
    let huf = create_huffman_lookup_table();
    progress("parse", 0.05);

    let max_tick_guess = 2_000_000; // ~8.7 hours at 64 tick
    let sampled = |offset: i32| -> Vec<i32> {
        (0..max_tick_guess / SAMPLE_INTERVAL).map(|i| i * SAMPLE_INTERVAL + offset).collect()
    };

    // Running the passes concurrently is slower in practice (each pass is already multi-threaded
    // and memory-bandwidth bound), so they run one after another unless REWIND_PARALLEL is set.
    let seq = std::env::var("REWIND_PARALLEL").is_err();
    let (ev_out, tick_out, proj_out) = std::thread::scope(|s| {
        let h_ev = s.spawn(|| {
            let mut props: Vec<&str> = EVENT_PLAYER_PROPS.to_vec();
            props.dedup();
            let t = std::time::Instant::now();
            let r = run_parser(bytes, make_inputs(&huf, &props, WANTED_EVENTS, vec![], false));
            if std::env::var("REWIND_TIMING").is_ok() { eprintln!("events pass {:?}", t.elapsed()); }
            progress("events", 0.35);
            r
        });
        if seq { while !h_ev.is_finished() { std::thread::sleep(std::time::Duration::from_millis(5)); } }
        let h_tick = s.spawn(|| {
            let t = std::time::Instant::now();
            let r = run_parser(bytes, make_inputs(&huf, TICK_PROPS, &[], sampled(0), false));
            if std::env::var("REWIND_TIMING").is_ok() { eprintln!("ticks pass {:?}", t.elapsed()); }
            progress("positions", 0.55);
            r
        });
        if seq { while !h_tick.is_finished() { std::thread::sleep(std::time::Duration::from_millis(5)); } }
        let h_proj = s.spawn(|| {
            let t = std::time::Instant::now();
            let r = run_parser(bytes, make_inputs(&huf, &[], &[], vec![], true));
            if std::env::var("REWIND_TIMING").is_ok() { eprintln!("proj pass {:?}", t.elapsed()); }
            progress("grenades", 0.65);
            r
        });
        let j = |h: std::thread::ScopedJoinHandle<'_, Result<DemoOutput>>| {
            h.join().unwrap_or_else(|_| Err(Error::Parse("parser thread panicked".into())))
        };
        (j(h_ev), j(h_tick), j(h_proj))
    });

    let mut ev_out = ev_out?;
    let mut tick_out = tick_out?;
    let mut ticks = Table::from_output(&mut tick_out);
    let mut tick_offset = 0;
    // Some demos might only carry snapshots on odd ticks; if sampling on multiples of
    // SAMPLE_INTERVAL produced (almost) nothing, retry shifted by one tick.
    if ticks.rows < 50 {
        for off in 1..SAMPLE_INTERVAL {
            let mut o = run_parser(bytes, make_inputs(&huf, TICK_PROPS, &[], sampled(off), false))?;
            let t = Table::from_output(&mut o);
            if t.rows > ticks.rows {
                ticks = t;
                tick_offset = off;
            }
            if ticks.rows >= 50 {
                break;
            }
        }
    }
    // Grenade trajectories are a nice-to-have: tolerate failures there.
    let projectiles = match proj_out {
        Ok(mut o) => Table::from_output(&mut o),
        Err(_) => Table { cols: HashMap::new(), rows: 0 },
    };

    let header: HashMap<String, String> = ev_out
        .header
        .take()
        .map(|h| h.into_iter().collect())
        .unwrap_or_default();
    let convars: HashMap<String, String> = std::mem::take(&mut ev_out.convars).into_iter().collect();
    let mut roster = vec![];
    let md = if !ev_out.player_md.is_empty() { &ev_out.player_md } else { &ev_out.roster };
    for p in md {
        if let Some(sid) = p.steamid {
            roster.push((sid, p.name.clone().unwrap_or_default(), p.team_number.unwrap_or(0)));
        }
    }
    let mut voice = Vec::new();
    for (tick, v) in std::mem::take(&mut ev_out.voice_data) {
        if let Some(a) = &v.audio {
            let data = a.voice_data();
            if data.is_empty() {
                continue;
            }
            voice.push(VoicePacket {
                tick,
                xuid: v.xuid(),
                section: a.section_number(),
                data: data.to_vec(),
                sample_rate: a.sample_rate(),
                format: a.format.unwrap_or(0),
            });
        }
    }
    let events = convert_events(std::mem::take(&mut ev_out.game_events));
    progress("parsed", 0.7);
    Ok(RawDemo {
        header,
        events,
        ticks,
        tick_stride: SAMPLE_INTERVAL,
        tick_offset,
        projectiles,
        voice,
        convars,
        roster,
    })
}
