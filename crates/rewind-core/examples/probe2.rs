use ahash::AHashMap;
use cs2_demoparser::first_pass::parser_settings::{rm_user_friendly_names, ParserInputs};
use cs2_demoparser::parse_demo::{Parser, ParsingMode};
use cs2_demoparser::second_pass::parser_settings::create_huffman_lookup_table;
use cs2_demoparser::second_pass::variants::VarVec;

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let mode = std::env::args().nth(2).unwrap_or("ticks".into());
    let bytes = std::fs::read(&path).unwrap();
    let huf = create_huffman_lookup_table();
    let t = std::time::Instant::now();
    let pprops: Vec<String> = if mode == "ticks" { ["X", "Y", "Z", "yaw", "health", "team_num", "is_warmup_period", "total_rounds_played", "team_rounds_total", "team_clan_name", "game_phase", "balance", "active_weapon_name", "duck_amount", "flash_duration", "is_connected"].iter().map(|s| s.to_string()).collect() } else { vec![] };
    let real = rm_user_friendly_names(&pprops).unwrap();
    let mut r2o = AHashMap::default();
    for (r, o) in real.iter().zip(&pprops) { r2o.insert(r.clone(), o.clone()); }
    let wanted_ticks: Vec<i32> = if mode == "ticks4" { (0..400000).step_by(4).collect() } else { vec![] };
    let settings = ParserInputs {
        real_name_to_og_name: r2o,
        wanted_players: vec![],
        wanted_player_props: real,
        wanted_other_props: vec![],
        wanted_prop_states: AHashMap::default(),
        wanted_ticks,
        wanted_events: vec![],
        parse_ents: true,
        parse_projectiles: mode == "proj",
        parse_grenades: false,
        parse_weapons: false,
        only_header: false,
        list_props: false,
        only_convars: false,
        huffman_lookup_table: &huf,
        order_by_steamid: false,
        fallback_bytes: None,
    };
    let mut p = Parser::new(settings, ParsingMode::Normal);
    let out = p.parse_demo(&bytes).unwrap();
    eprintln!("parse {:?}", t.elapsed());
    for pi in &out.prop_controller.prop_infos {
        if let Some(col) = out.df.get(&pi.id) {
            let n = match &col.data { Some(VarVec::F32(v)) => v.len(), Some(VarVec::I32(v)) => v.len(), Some(VarVec::U32(v)) => v.len(), Some(VarVec::U64(v)) => v.len(), Some(VarVec::String(v)) => v.len(), Some(VarVec::Bool(v)) => v.len(), _ => 0 };
            let sample = match &col.data { Some(VarVec::F32(v)) => format!("{:?}", &v[..v.len().min(12)]), Some(VarVec::I32(v)) => format!("{:?}", &v[v.len()/2..(v.len()/2+12).min(v.len())]), Some(VarVec::U32(v)) => format!("{:?}", &v[v.len()/2..(v.len()/2+12).min(v.len())]), Some(VarVec::U64(v)) => format!("{:?}", &v[..v.len().min(12)]), Some(VarVec::String(v)) => format!("{:?}", &v[v.len()/2..(v.len()/2+12).min(v.len())]), Some(VarVec::Bool(v)) => format!("{:?}", &v[v.len()/2..(v.len()/2+12).min(v.len())]), _ => String::new() };
            println!("{} ({}) n={} nones={} {}", pi.prop_friendly_name, pi.prop_name, n, col.num_nones, sample);
        } else { println!("{} missing", pi.prop_friendly_name); }
    }
    if let Some(col) = out.df.get(&cs2_demoparser::first_pass::prop_controller::TICK_ID) {
        if let Some(VarVec::I32(v)) = &col.data {
            let mut ticks: Vec<i32> = v.iter().flatten().cloned().collect(); ticks.dedup();
            let mut hist = std::collections::BTreeMap::new();
            for w in ticks.windows(2) { *hist.entry(w[1]-w[0]).or_insert(0) += 1; }
            println!("unique ticks {} first {:?} last {:?} deltas {:?}", ticks.len(), ticks.first(), ticks.last(), hist.iter().take(10).collect::<Vec<_>>());
        }
    }
}
